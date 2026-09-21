// ============================================================================
// server.js
// ----------------------------------------------------------------------------
// 这是一个非常轻量的 Node.js / Express 后端，只做一件事：
// 帮前端网页"转发"请求到阿里云百炼（Model Studio），解决浏览器直接调用第三方
// API 时会遇到的 CORS（跨域）限制问题。
//
// 提供两个接口：
//   1) POST /api/clone-voice   上传一段参考音频 -> 调用阿里云"声音复刻"接口
//                               -> 返回一个专属音色 ID（voiceId）
//   2) POST /api/synthesize    传入 voiceId + 要合成的文字 -> 调用阿里云
//                               "语音合成"接口 -> 返回合成好的音频下载地址
//
// 阿里云 API Key 完全由前端页面输入、随每次请求一起发过来，本文件里不出现、
// 也不会保存任何真实的 Key，符合"不要硬编码密钥"的要求。
// ============================================================================

const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();

// ----------------------------------------------------------------------------
// 基础中间件
// ----------------------------------------------------------------------------
// MVP 阶段先允许所有来源跨域调用，方便你把前端部署到 Vercel 上快速联调。
// 如果之后想收紧安全性，可以把 cors() 改成 cors({ origin: '你的前端域名' })。
app.use(cors());
app.use(express.json({ limit: '2mb' })); // 解析 JSON 请求体（/api/synthesize 用得到）

// 上传的参考音频先存进内存（不写磁盘）。
// 原因：Render / Railway 这类平台的磁盘是"临时"的，容器重启后文件就没了，
// MVP 阶段音频只是"路过"一下后端、转发给阿里云，没必要真的存文件。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 阿里云要求参考音频 ≤ 10MB
});

// ----------------------------------------------------------------------------
// 阿里云百炼（新加坡地域）相关配置
// ----------------------------------------------------------------------------
// 【重要 · 技术选型说明，请务必读一下】
// 阿里云百炼里"能克隆声音"的模型系列不止一个（CosyVoice / Qwen-Audio-TTS /
// Qwen-TTS），它们的调用方式差别很大。本项目选择了 Qwen-TTS 这条路线，原因：
//   1. 创建音色 + 合成语音都是标准 HTTP POST 接口，不需要用 WebSocket，
//      在 Node.js 后端里实现和排查问题都更简单，适合 MVP。
//   2. 上传参考音频时可以直接传 Base64 编码的音频数据，不需要先把音频
//      传到阿里云 OSS、拿到一个公网可访问的 URL 才能用（省掉一整套 OSS 配置）。
//   3. 调用的域名是通用国际域名 dashscope-intl.aliyuncs.com，不需要你在
//      百炼控制台看到的、形如 {WorkspaceId}.ap-southeast-1.maas.aliyuncs.com
//      的"工作空间专属域名"（那个域名主要是给 CosyVoice 的实时语音合成 /
//      WebSocket 接口用的，实现复杂度会高很多）。
//
// 也就是说：你在需求里提供的域名，本项目【没有直接使用】——这是我特意做的
// 技术选型，不是遗漏，原因见上面 3 点。如果你之后想换成 CosyVoice 或用到
// Workspace 专属域名，可以参考 README.md 最后的"扩展方向"章节。
//
// 以下接口路径和参数格式基于阿里云官方文档（声音复刻 / 非实时语音合成）整理，
// 但阿里云偶尔会调整细节，如果调用报错，请对照百炼控制台的最新文档核对一下：
// https://www.alibabacloud.com/help/zh/model-studio/voice-cloning-user-guide
// https://www.alibabacloud.com/help/zh/model-studio/non-realtime-tts-user-guide
const DASHSCOPE_BASE_URL = 'https://dashscope-intl.aliyuncs.com/api/v1';
const VOICE_CLONE_ENDPOINT = `${DASHSCOPE_BASE_URL}/services/audio/tts/customization`;
const TTS_ENDPOINT = `${DASHSCOPE_BASE_URL}/services/aigc/multimodal-generation/generation`;

// 声音复刻、语音合成必须使用【同一个】模型名，这里统一定义成一个常量，避免两处写得不一致。
// 注意：阿里云会不定期发布新的"快照版"模型（比如 qwen3-tts-vc-2026-01-22 之后可能会有更新的日期版本）。
// 如果调用时报"模型不存在"之类的错误，去百炼控制台 -> 语音合成 -> Qwen-TTS 页面，
// 核对当前新加坡地域下 Qwen3-TTS-VC 系列最新的模型名，替换下面这一行即可。
const TTS_MODEL = 'qwen3-tts-vc-2026-01-22';

// ----------------------------------------------------------------------------
// 工具函数：统一调用阿里云接口 + 统一处理报错格式
// ----------------------------------------------------------------------------
async function callDashScope(url, apiKey, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // 阿里云出错时通常也会返回 JSON（带 code / message），这里尽量解析出来，
  // 就算解析失败也不让程序崩溃。
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = data.message || data.Message || `阿里云接口返回 HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status >= 400 && resp.status < 600 ? resp.status : 500;
    err.aliyunResponse = data;
    throw err;
  }
  return data;
}

// ----------------------------------------------------------------------------
// 接口一：声音复刻
// 前端用 multipart/form-data 传两个字段：
//   - apiKey  文本字段，阿里云百炼 API Key
//   - audio   文件字段，参考音频（wav / mp3 / m4a）
// ----------------------------------------------------------------------------
app.post('/api/clone-voice', upload.single('audio'), async (req, res) => {
  try {
    const apiKey = req.body.apiKey;
    if (!apiKey) {
      return res.status(400).json({ error: '缺少阿里云百炼 API Key' });
    }
    if (!req.file) {
      return res.status(400).json({ error: '没有收到参考音频文件' });
    }

    // 把上传的音频转换成 Base64 Data URI（形如 data:audio/wav;base64,xxxx），
    // 阿里云的声音复刻接口支持直接传这种格式，不需要额外的公网 URL。
    const mimeType = req.file.mimetype || 'audio/wav';
    const base64Audio = req.file.buffer.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64Audio}`;

    const result = await callDashScope(VOICE_CLONE_ENDPOINT, apiKey, {
      model: 'qwen-voice-enrollment', // 固定值，阿里云文档规定不要修改
      input: {
        action: 'create',
        target_model: TTS_MODEL,
        // 音色名前缀，方便你之后在阿里云控制台里区分是哪次上传生成的音色
        preferred_name: `mvp-${Date.now()}`,
        audio: { data: dataUri },
      },
    });

    // Qwen-TTS 系列返回的音色 ID 字段名是 output.voice
    // （注意：CosyVoice / Qwen-Audio-TTS 系列返回的字段名是 output.voice_id，两者不一样）
    const voiceId = result && result.output && result.output.voice;
    if (!voiceId) {
      throw new Error('阿里云响应里没有找到 voice 字段，原始响应：' + JSON.stringify(result));
    }

    res.json({ voiceId });
  } catch (err) {
    console.error('[clone-voice] 出错:', err.message);
    res.status(err.status || 500).json({
      error: '声音复刻失败：' + err.message,
      detail: err.aliyunResponse || null,
    });
  }
});

// ----------------------------------------------------------------------------
// 接口二：语音合成
// 前端用 JSON 传三个字段：apiKey / voiceId / text
// ----------------------------------------------------------------------------
app.post('/api/synthesize', async (req, res) => {
  try {
    const { apiKey, voiceId, text } = req.body || {};
    if (!apiKey) return res.status(400).json({ error: '缺少阿里云百炼 API Key' });
    if (!voiceId) return res.status(400).json({ error: '缺少 voiceId，请先完成声音复刻这一步' });
    if (!text || !text.trim()) return res.status(400).json({ error: '要合成的文本不能为空' });
    if (text.length > 2000) return res.status(400).json({ error: '文本过长，请控制在 2000 字以内' });

    const result = await callDashScope(TTS_ENDPOINT, apiKey, {
      model: TTS_MODEL,
      input: {
        text,
        voice: voiceId,
      },
    });

    // 非流式模式下，阿里云返回一个"有效期 24 小时"的音频下载地址
    const audioUrl = result && result.output && result.output.audio && result.output.audio.url;
    if (!audioUrl) {
      throw new Error('阿里云响应里没有找到音频地址，原始响应：' + JSON.stringify(result));
    }

    res.json({ audioUrl });
  } catch (err) {
    console.error('[synthesize] 出错:', err.message);
    res.status(err.status || 500).json({
      error: '语音合成失败：' + err.message,
      detail: err.aliyunResponse || null,
    });
  }
});

// 健康检查接口：部署完成后，用浏览器打开 你的后端地址/api/health
// 如果看到 {"status":"ok"} 就说明后端启动成功了。
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// multer 文件大小超限等错误的统一兜底处理
app.use((err, req, res, next) => {
  if (err) {
    console.error('[未捕获错误]', err.message);
    return res.status(400).json({ error: err.message });
  }
  next();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ 后端已启动，正在监听端口 ${PORT}`);
  console.log(`   本地测试地址：http://localhost:${PORT}/api/health`);
});
