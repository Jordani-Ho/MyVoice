// ============================================================================
// server.js
// ----------------------------------------------------------------------------
// 轻量 Node.js / Express 后端，帮前端网页转发请求到阿里云百炼（Model Studio，
// 新加坡节点），解决浏览器直接调用第三方 API 时的 CORS（跨域）限制问题。
//
// 【2026-09-22 更新说明 · 请务必先读这一段】
// 这版代码换成了 qwen-audio-3.0-tts-plus 模型（Qwen-Audio-TTS 系列），
// 替换了之前用的 qwen3-tts-vc-2026-01-22（Qwen-TTS 系列）。这两个系列的调用
// 方式完全不同，不是简单改个模型名字符串就行，所以这版代码结构改动比较大：
//
//   0. 模型名选型说明：一开始按你的要求改成过 qwen-audio-3.1-tts-flash，
//      但实测你的账号对这个模型返回 "Access to model denied"——阿里云控制台
//      "模型广场" 页面显示的免费额度，不代表账号已经拿到调用权限，需要显式
//      "开通"过的模型才能真正调用。你确认自己开通过的是 qwen-audio-3.0-tts-plus，
//      所以这版改用这个。它和 3.1-tts-flash 是同一个模型系列，接口、协议完全
//      一样，只是模型名字符串不同，下面 1/2/3 点的架构说明同样适用。如果调用
//      时仍然报 "Access to model denied"，去百炼控制台该模型的详情页确认一下
//      是否显示"已开通"或能点击"立即体验"，没有的话可能需要先手动开通一次。
//
//   1. 声音复刻（创建音色）：接口路径、请求体字段名都变了，而且这个模型系列的
//      "url" 参数要求传一个真正能被阿里云服务器访问到的公网地址，不能像之前
//      那样直接传 Base64。解决办法：后端把你上传的音频临时"挂"在自己身上
//      （/api/temp-audio/:id），再把这个地址交给阿里云去抓取。
//
//   2. 语音合成：这个模型系列"非实时"（简单 HTTP 请求/响应）合成接口只在
//      北京地域开放，新加坡地域只能走"实时语音合成"，也就是 WebSocket 协议
//      （run-task / continue-task / finish-task 三个事件）。所以这版后端
//      引入了 ws 这个包，通过 WebSocket 请求阿里云、把分段返回的二进制音频
//      拼接起来，再作为一个完整的 mp3 文件返回给前端（不再是"返回一个下载
//      链接"，而是直接把音频数据发回去）。
//
//   3. 因为要用到"工作空间专属域名"（形如 {WorkspaceId}.ap-southeast-1.
//      maas.aliyuncs.com），这版后端新增了一个必须配置的环境变量：
//      ALIYUN_WORKSPACE_ID（你的阿里云百炼 Workspace ID）。部署到 Render 后，
//      记得在 Render 的 Environment 页面里加上这个变量，否则接口会报错提醒你。
//
// 阿里云 API Key 仍然完全由前端页面输入、随每次请求一起发过来，本文件里不
// 出现、也不会保存任何真实的 Key。
// ============================================================================

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const app = express();
app.set('trust proxy', true); // Render 在前面做了一层反向代理，这样 req.protocol 才能正确显示 https

// ----------------------------------------------------------------------------
// 基础中间件
// ----------------------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 阿里云要求参考音频 ≤ 10MB
});

// ----------------------------------------------------------------------------
// 阿里云百炼（新加坡地域）相关配置
// ----------------------------------------------------------------------------
const ALIYUN_WORKSPACE_ID = process.env.ALIYUN_WORKSPACE_ID || '';
// 如果部署环境没有显式配置 PUBLIC_BASE_URL，就从请求头里自动推断（Render 部署下通常也能正常工作）。
const PUBLIC_BASE_URL_ENV = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

const REGION_DOMAIN = ALIYUN_WORKSPACE_ID ? `${ALIYUN_WORKSPACE_ID}.ap-southeast-1.maas.aliyuncs.com` : '';
const VOICE_CLONE_ENDPOINT = REGION_DOMAIN ? `https://${REGION_DOMAIN}/api/v1/services/audio/tts/customization` : '';
const WS_ENDPOINT = REGION_DOMAIN ? `wss://${REGION_DOMAIN}/api-ws/v1/inference` : '';

// 声音复刻、语音合成必须使用同一个模型名。这里用的是你确认已经开通的
// qwen-audio-3.0-tts-plus；如果之后开通了别的 Qwen-Audio-TTS 系列模型
// （比如 qwen-audio-3.0-tts-flash 或 qwen-audio-3.1-tts-flash），
// 改这一行就行，其他代码不用动。
const TTS_MODEL = 'qwen-audio-3.0-tts-plus';

function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL_ENV) return PUBLIC_BASE_URL_ENV;
  return `${req.protocol}://${req.get('host')}`;
}

function ensureWorkspaceConfigured(res) {
  if (!ALIYUN_WORKSPACE_ID) {
    res.status(500).json({
      error: '后端还没有配置 ALIYUN_WORKSPACE_ID 环境变量，请在 Render 的 Environment 设置里添加后重新部署。',
    });
    return false;
  }
  return true;
}

// ----------------------------------------------------------------------------
// 临时音频托管：声音复刻接口要求传一个"公网可访问"的音频 URL，
// 所以把用户刚上传的文件临时存一份在内存里，挂到 /api/temp-audio/:id 上，
// 让阿里云的服务器能抓取到。有效期 10 分钟，一次性够用，过期自动清理。
// ----------------------------------------------------------------------------
const tempAudioStore = new Map(); // id -> { buffer, mimeType, expiresAt }
const TEMP_AUDIO_TTL_MS = 10 * 60 * 1000;

function pruneExpiredTempAudio() {
  const now = Date.now();
  for (const [id, entry] of tempAudioStore) {
    if (entry.expiresAt < now) tempAudioStore.delete(id);
  }
}

app.get('/api/temp-audio/:id', (req, res) => {
  pruneExpiredTempAudio();
  const entry = tempAudioStore.get(req.params.id);
  if (!entry) return res.status(404).send('音频不存在或已过期');
  res.setHeader('Content-Type', entry.mimeType);
  res.send(entry.buffer);
});

// ----------------------------------------------------------------------------
// 接口一：声音复刻
// ----------------------------------------------------------------------------
app.post('/api/clone-voice', upload.single('audio'), async (req, res) => {
  try {
    if (!ensureWorkspaceConfigured(res)) return;

    const apiKey = req.body.apiKey;
    if (!apiKey) return res.status(400).json({ error: '缺少阿里云百炼 API Key' });
    if (!req.file) return res.status(400).json({ error: '没有收到参考音频文件' });

    // 1) 临时挂出这段音频，生成一个阿里云服务器能访问到的公网地址
    pruneExpiredTempAudio();
    const audioId = randomUUID();
    const mimeType = req.file.mimetype || 'audio/wav';
    tempAudioStore.set(audioId, {
      buffer: req.file.buffer,
      mimeType,
      expiresAt: Date.now() + TEMP_AUDIO_TTL_MS,
    });
    const publicAudioUrl = `${getPublicBaseUrl(req)}/api/temp-audio/${audioId}`;

    // 2) 调用声音复刻接口，注意这个模型系列用的是 "url" 字段（公网地址），
    //    而不是 Qwen-TTS 系列那种可以直接传 Base64 的 "data" 字段。
    const resp = await fetch(VOICE_CLONE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'voice-enrollment', // 固定值，不要修改
        input: {
          action: 'create_voice', // 固定值，不要修改
          target_model: TTS_MODEL,
          prefix: `v${Date.now()}`.slice(0, 16), // 音色名前缀，字母数字为主，控制长度
          url: publicAudioUrl,
        },
      }),
    });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const msg = data.message || data.Message || `阿里云接口返回 HTTP ${resp.status}`;
      return res.status(resp.status >= 400 && resp.status < 600 ? resp.status : 500).json({
        error: '声音复刻失败：' + msg,
        detail: data,
      });
    }

    // 注意：Qwen-Audio-TTS 系列返回的音色 ID 字段名是 output.voice_id
    // （Qwen-TTS 系列返回的是 output.voice，两者不一样，别搞混）
    const voiceId = data && data.output && data.output.voice_id;
    if (!voiceId) {
      return res.status(500).json({
        error: '阿里云响应里没有找到 voice_id 字段',
        detail: data,
      });
    }

    res.json({ voiceId });
  } catch (err) {
    console.error('[clone-voice] 出错:', err.message);
    res.status(500).json({ error: '声音复刻失败：' + err.message });
  }
});

// ----------------------------------------------------------------------------
// 通过 WebSocket 调用阿里云"实时语音合成"，把分段返回的二进制音频拼接成
// 一个完整的 mp3 Buffer。协议细节（run-task / continue-task / finish-task）
// 来自阿里云官方文档的 Node.js 示例。
// ----------------------------------------------------------------------------
function synthesizeViaWebSocket({ apiKey, voiceId, text }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_ENDPOINT, {
      headers: { Authorization: `bearer ${apiKey}` },
    });

    const taskId = randomUUID();
    const audioChunks = [];
    let settled = false;

    const timeout = setTimeout(() => {
      finish(new Error('语音合成超时（30 秒内未收到完整结果）'));
    }, 30000);

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.terminate(); } catch (_) { /* 忽略关闭时的报错 */ }
      if (err) reject(err); else resolve(result);
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model: TTS_MODEL,
          parameters: {
            text_type: 'PlainText',
            voice: voiceId,
            format: 'mp3',
            sample_rate: 24000,
            volume: 50,
            rate: 1,
            pitch: 1,
            enable_ssml: false,
          },
          input: {},
        },
      }));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        audioChunks.push(data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (_e) {
        return;
      }
      const event = msg && msg.header && msg.header.event;

      if (event === 'task-started') {
        // 任务建立后，一次性把全部文本发过去，再立刻结束任务
        ws.send(JSON.stringify({
          header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
          payload: { input: { text } },
        }));
        ws.send(JSON.stringify({
          header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
          payload: { input: {} },
        }));
      } else if (event === 'task-finished') {
        finish(null, Buffer.concat(audioChunks));
      } else if (event === 'task-failed') {
        finish(new Error((msg.header && msg.header.error_message) || '阿里云语音合成任务失败'));
      }
    });

    ws.on('error', (err) => finish(new Error('WebSocket 连接出错：' + err.message)));
    ws.on('close', () => finish(new Error('WebSocket 连接在任务完成前意外关闭')));
  });
}

// ----------------------------------------------------------------------------
// 接口二：语音合成
// 注意：这版返回的不再是 JSON { audioUrl }，而是直接返回 audio/mpeg 二进制数据。
// ----------------------------------------------------------------------------
app.post('/api/synthesize', async (req, res) => {
  try {
    if (!ensureWorkspaceConfigured(res)) return;

    const { apiKey, voiceId, text } = req.body || {};
    if (!apiKey) return res.status(400).json({ error: '缺少阿里云百炼 API Key' });
    if (!voiceId) return res.status(400).json({ error: '缺少 voiceId，请先完成声音复刻这一步' });
    if (!text || !text.trim()) return res.status(400).json({ error: '要合成的文本不能为空' });
    if (text.length > 2000) return res.status(400).json({ error: '文本过长，请控制在 2000 字以内' });

    const audioBuffer = await synthesizeViaWebSocket({ apiKey, voiceId, text });
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
  if (!ALIYUN_WORKSPACE_ID) {
    console.warn('⚠️  还没有设置 ALIYUN_WORKSPACE_ID 环境变量，声音复刻/语音合成接口会报错。');
  }
});
