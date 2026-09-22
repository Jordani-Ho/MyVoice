// ============================================================================
// server.js
// ----------------------------------------------------------------------------
// 轻量 Node.js / Express 后端，帮前端网页转发请求到 ElevenLabs，解决浏览器
// 直接调用第三方 API 时的 CORS（跨域）限制问题。
//
// 【2026-09-22 更新说明】
// 从这版开始换成 ElevenLabs，替换掉之前的阿里云百炼。原因：阿里云那边"声音
// 复刻"这个能力一直卡在账号权限（AccessDenied.Unpurchased），客服回复也
// 不明确；ElevenLabs 是自助式服务，注册完直接能用，不用等审核。
//
// 顺带一提：这版代码比阿里云那版简单很多——ElevenLabs 的声音复刻和语音合成
// 都是普通的 HTTP 请求/响应，不需要 WebSocket，也不需要把音频先"挂"到一个
// 公网地址上（可以直接把文件转发过去）。前端 index.html 完全不用改，因为
// 它已经是按"/api/synthesize 直接返回音频二进制数据"这个约定写的。
//
// ElevenLabs 的 API Key 完全由前端页面输入、随每次请求一起发过来，本文件里
// 不出现、也不会保存任何真实的 Key。
// ============================================================================

const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();

// ----------------------------------------------------------------------------
// 基础中间件
// ----------------------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 参考音频 ≤ 10MB
});

// ----------------------------------------------------------------------------
// ElevenLabs 相关配置
// ----------------------------------------------------------------------------
const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';
const VOICE_CLONE_ENDPOINT = `${ELEVENLABS_BASE_URL}/voices/add`;

// 用来做语音合成的模型。eleven_multilingual_v2 支持中英文混合，质量和稳定性
// 都不错，是目前推荐的默认选择。如果想要更低延迟/更省成本，可以换成
// eleven_flash_v2_5（说明书：https://elevenlabs.io/docs/models）。
const TTS_MODEL = 'eleven_multilingual_v2';

// ----------------------------------------------------------------------------
// 接口一：声音复刻
// 前端用 multipart/form-data 传两个字段：apiKey（文本）、audio（文件）
// ----------------------------------------------------------------------------
app.post('/api/clone-voice', upload.single('audio'), async (req, res) => {
  try {
    const apiKey = req.body.apiKey;
    if (!apiKey) return res.status(400).json({ error: '缺少 ElevenLabs API Key' });
    if (!req.file) return res.status(400).json({ error: '没有收到参考音频文件' });

    const mimeType = req.file.mimetype || 'audio/wav';
    const form = new FormData();
    form.append('name', `MyVoice-${Date.now()}`);
    // 注意：字段名是 "files"（不带方括号）。ElevenLabs 官方文档的 curl 示例里
    // 写的是 files[]，那只是 curl 表示"这是个数组字段"的习惯写法，实际服务端
    // 按名字 "files" 来解析——之前用 files[] 试过，会报 "files 字段缺失"。
    form.append('files', new Blob([req.file.buffer], { type: mimeType }), req.file.originalname || 'sample.wav');

    const resp = await fetch(VOICE_CLONE_ENDPOINT, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey }, // 注意：ElevenLabs 用的是 xi-api-key 这个头，不是 Authorization: Bearer
      body: form,
    });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const msg = (data.detail && (data.detail.message || JSON.stringify(data.detail))) || data.message || `ElevenLabs 接口返回 HTTP ${resp.status}`;
      return res.status(resp.status >= 400 && resp.status < 600 ? resp.status : 500).json({
        error: '声音复刻失败：' + msg,
        detail: data,
      });
    }

    const voiceId = data.voice_id;
    if (!voiceId) {
      return res.status(500).json({ error: 'ElevenLabs 响应里没有找到 voice_id 字段', detail: data });
    }

    res.json({ voiceId });
  } catch (err) {
    console.error('[clone-voice] 出错:', err.message);
    res.status(500).json({ error: '声音复刻失败：' + err.message });
  }
});

// ----------------------------------------------------------------------------
// 接口二：语音合成
// 前端用 JSON 传三个字段：apiKey / voiceId / text
// 直接把 ElevenLabs 返回的音频二进制数据转发给前端（Content-Type: audio/mpeg）
// ----------------------------------------------------------------------------
app.post('/api/synthesize', async (req, res) => {
  try {
    const { apiKey, voiceId, text } = req.body || {};
    if (!apiKey) return res.status(400).json({ error: '缺少 ElevenLabs API Key' });
    if (!voiceId) return res.status(400).json({ error: '缺少 voiceId，请先完成声音复刻这一步' });
    if (!text || !text.trim()) return res.status(400).json({ error: '要合成的文本不能为空' });
    if (text.length > 2000) return res.status(400).json({ error: '文本过长，请控制在 2000 字以内' });

    const resp = await fetch(
      `${ELEVENLABS_BASE_URL}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text, model_id: TTS_MODEL }),
      }
    );

    if (!resp.ok) {
      // 出错时 ElevenLabs 返回的是 JSON，成功时返回的是音频二进制，要分开处理
      const data = await resp.json().catch(() => ({}));
      const msg = (data.detail && (data.detail.message || JSON.stringify(data.detail))) || data.message || `ElevenLabs 接口返回 HTTP ${resp.status}`;
      return res.status(resp.status >= 400 && resp.status < 600 ? resp.status : 500).json({
        error: '语音合成失败：' + msg,
        detail: data,
      });
    }

    const audioBuffer = Buffer.from(await resp.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.send(audioBuffer);
  } catch (err) {
    console.error('[synthesize] 出错:', err.message);
    res.status(500).json({ error: '语音合成失败：' + err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

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
