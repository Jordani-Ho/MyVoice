// ============================================================================
// server.js
// ----------------------------------------------------------------------------
// 轻量 Node.js / Express 后端，做两件事：
//   1. 帮 frontend/index.html 这个网页转发请求到 ElevenLabs（解决浏览器
//      直接调用第三方 API 时的 CORS 跨域限制）。
//   2. 【2026-09-22 新增】同时把"学声音 / 用声音念文字"包装成一个
//      远程 MCP（Model Context Protocol）服务，挂在 /mcp 这个地址上。
//      Claude App、ChatGPT App 这类支持"添加第三方连接"的手机端智能体，
//      可以在自己的设置里把这个地址加进去，之后跟它们对话时就能直接
//      调用"用我的声音念出来"这个功能，不需要另装 App，也不需要在
//      电脑上跑任何东西——这一点和之前 skill/ 目录下那版只能被
//      Claude Code / Codex CLI 这类桌面工具调用的版本不一样，那版走的是
//      本地 stdio 通道，这版走的是公网可访问的 HTTP。
//
// 【技术选型历史，供以后回顾】
// 最早用的是阿里云百炼 Qwen-TTS，后来因为"声音复刻"这个能力一直卡在账号
// 权限审核（AccessDenied.Unpurchased、客服回复不明确），换成了 ElevenLabs——
// 自助式服务，注册完直接能用。ElevenLabs 的声音复刻和语音合成都是普通的
// HTTP 请求/响应，不需要 WebSocket，也不需要把音频先"挂"到一个公网地址上。
//
// ElevenLabs 的 API Key 完全由调用方传入（网页前端的输入框，或者 MCP 工具
// 调用时的参数/环境变量），本文件里不出现、也不会保存任何真实的 Key。
// ============================================================================

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

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
// 核心逻辑：抽成两个共用函数，网页的 REST 接口和下面的 MCP 工具都调用这两个，
// 避免同一段"调用 ElevenLabs"的代码写两遍、以后改一处漏改一处。
// ----------------------------------------------------------------------------

// 声音复刻：传入音频的二进制数据（Buffer）和 MIME 类型，返回 voiceId。
// 出错时抛出的 Error 自带一个 .status 字段（HTTP 状态码），方便上层原样透传。
async function cloneVoiceCore(apiKey, audioBuffer, mimeType, filename) {
  const form = new FormData();
  form.append('name', `MyVoice-${Date.now()}`);
  // 注意：字段名是 "files"（不带方括号）。ElevenLabs 官方文档的 curl 示例里
  // 写的是 files[]，那只是 curl 表示"这是个数组字段"的习惯写法，实际服务端
  // 按名字 "files" 来解析——之前用 files[] 试过，会报 "files 字段缺失"。
  form.append('files', new Blob([audioBuffer], { type: mimeType || 'audio/wav' }), filename || 'sample.wav');

  const resp = await fetch(VOICE_CLONE_ENDPOINT, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey }, // 注意：ElevenLabs 用的是 xi-api-key 这个头，不是 Authorization: Bearer
    body: form,
  });
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = (data.detail && (data.detail.message || JSON.stringify(data.detail))) || data.message || `ElevenLabs 接口返回 HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status >= 400 && resp.status < 600 ? resp.status : 500;
    err.detail = data;
    throw err;
  }

  const voiceId = data.voice_id;
  if (!voiceId) {
    const err = new Error('ElevenLabs 响应里没有找到 voice_id 字段');
    err.status = 500;
    err.detail = data;
    throw err;
  }
  return voiceId;
}

// 语音合成：传入 voiceId 和文字，返回音频的二进制数据（Buffer，mp3 格式）。
async function synthesizeCore(apiKey, voiceId, text) {
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
    const data = await resp.json().catch(() => ({}));
    const msg = (data.detail && (data.detail.message || JSON.stringify(data.detail))) || data.message || `ElevenLabs 接口返回 HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status >= 400 && resp.status < 600 ? resp.status : 500;
    err.detail = data;
    throw err;
  }

  return Buffer.from(await resp.arrayBuffer());
}

// ----------------------------------------------------------------------------
// 接口一：声音复刻（给网页用）
// 前端用 multipart/form-data 传两个字段：apiKey（文本）、audio（文件）
// ----------------------------------------------------------------------------
app.post('/api/clone-voice', upload.single('audio'), async (req, res) => {
  try {
    const apiKey = req.body.apiKey;
    if (!apiKey) return res.status(400).json({ error: '缺少 ElevenLabs API Key' });
    if (!req.file) return res.status(400).json({ error: '没有收到参考音频文件' });

    const voiceId = await cloneVoiceCore(apiKey, req.file.buffer, req.file.mimetype, req.file.originalname);
    res.json({ voiceId });
  } catch (err) {
    console.error('[clone-voice] 出错:', err.message);
    res.status(err.status || 500).json({ error: '声音复刻失败：' + err.message, detail: err.detail });
  }
});

// ----------------------------------------------------------------------------
// 接口二：语音合成（给网页用）
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

    const audioBuffer = await synthesizeCore(apiKey, voiceId, text);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.send(audioBuffer);
  } catch (err) {
    console.error('[synthesize] 出错:', err.message);
    res.status(err.status || 500).json({ error: '语音合成失败：' + err.message, detail: err.detail });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ----------------------------------------------------------------------------
// 远程 MCP 服务：/mcp
// 给 Claude App、ChatGPT App 这类"能添加第三方连接"的手机端智能体用。
// 没有做鉴权（谁知道这个地址都能连上）——跟网页那两个接口一样，MVP 阶段先这样，
// 长期用建议加一层访问口令。API Key 可以在连接时通过环境变量
// MYVOICE_API_KEY 配置好，也可以每次调用工具时由智能体当参数传进来。
// ----------------------------------------------------------------------------
const DEFAULT_API_KEY = process.env.MYVOICE_API_KEY || '';

const mcpServer = new McpServer({ name: 'myvoice', version: '1.0.0' });

mcpServer.registerTool(
  'synthesize_speech',
  {
    title: '用我的声音念出来',
    description:
      '把一段文字用之前学过的声音念出来，直接返回可播放的音频。回复用户之后，' +
      '如果想让这段回复也被听到，就调用这个工具、把回复原文传进来。' +
      '需要先有一个 voiceId——如果还没有，请用户先去网页上录一段话学习声音，' +
      '网页会给出 voiceId。',
    inputSchema: {
      voiceId: z.string().describe('要使用的音色 ID'),
      text: z.string().max(2000).describe('要朗读的文字，最多 2000 字'),
      apiKey: z.string().optional().describe('ElevenLabs API Key；服务端已配置时可省略'),
    },
  },
  async ({ voiceId, text, apiKey }) => {
    const key = apiKey || DEFAULT_API_KEY;
    if (!key) {
      return { isError: true, content: [{ type: 'text', text: '缺少 ElevenLabs API Key。' }] };
    }
    try {
      const audioBuffer = await synthesizeCore(key, voiceId, text);
      return {
        content: [
          { type: 'text', text: '已经用你的声音生成好了。' },
          { type: 'audio', data: audioBuffer.toString('base64'), mimeType: 'audio/mpeg' },
        ],
      };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `语音合成失败：${err.message}` }] };
    }
  }
);

mcpServer.registerTool(
  'clone_voice',
  {
    title: '学习我的声音',
    description:
      '传入一段音频的 Base64 编码数据，学习这段声音，返回 voiceId。' +
      '⚠️ 这个工具能不能用，取决于当前客户端能不能把音频文件的内容读出来传过来——' +
      '不是所有客户端都支持。如果这个工具用不了或者报错，更可靠的办法是让用户'  +
      '去网页版（声音工坊）上用"按住说话"那个功能学声音，学完之后把网页给的' +
      ' voiceId 记下来，之后就一直用 synthesize_speech 配这个 voiceId 就行，' +
      '不需要每次都重新学。',
    inputSchema: {
      audioBase64: z.string().describe('音频文件的 Base64 编码内容（不带 data: 前缀）'),
      mimeType: z.string().default('audio/wav').describe('音频的 MIME 类型，例如 audio/wav、audio/mpeg'),
      apiKey: z.string().optional().describe('ElevenLabs API Key；服务端已配置时可省略'),
    },
  },
  async ({ audioBase64, mimeType, apiKey }) => {
    const key = apiKey || DEFAULT_API_KEY;
    if (!key) {
      return { isError: true, content: [{ type: 'text', text: '缺少 ElevenLabs API Key。' }] };
    }
    try {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      if (audioBuffer.length === 0) {
        return { isError: true, content: [{ type: 'text', text: '收到的音频数据是空的。' }] };
      }
      const voiceId = await cloneVoiceCore(key, audioBuffer, mimeType, 'recording.wav');
      return {
        content: [
          { type: 'text', text: `已经学会这段声音了（voiceId = ${voiceId}）。接下来用 synthesize_speech 配这个 voiceId 就行。` },
        ],
      };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `学习声音失败：${err.message}` }] };
    }
  }
);

// StreamableHTTPServerTransport 用"有状态模式"：每次一个新会话就生成一个新的
// session id，多个客户端可以同时连接、互不干扰。一个进程里只需要一份
// McpServer + 一份 transport，全部 HTTP 请求都转发给它处理。
const mcpTransport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});
mcpServer.connect(mcpTransport).catch((err) => {
  console.error('[mcp] 启动失败:', err.message);
});

app.all('/mcp', async (req, res) => {
  try {
    await mcpTransport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] 处理请求出错:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'MCP 请求处理失败：' + err.message });
  }
});

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
  console.log(`   MCP 远程连接地址：http://localhost:${PORT}/mcp`);
});
