# 声音工坊 · 个人声音克隆与语音合成（MVP）

一个基于 ElevenLabs 声音克隆能力的最小可用产品：上传一段 5–20 秒的参考音频，
克隆出专属音色，再用这个音色朗读任意文字。

---

## 目录结构

```
voice-clone-mvp/
├── backend/                 后端：Node.js + Express
│   ├── server.js            核心代码（含详细中文注释）
│   ├── package.json
│   ├── package-lock.json
│   ├── .env.example
│   └── .gitignore
├── frontend/                 前端：纯 HTML / CSS / JS 单文件
│   └── index.html
└── README.md                 本文档
```

---

## 技术说明

后端调用的是 ElevenLabs 两个标准 HTTP 接口，都是普通 POST 请求/响应，
不需要 WebSocket，也不需要把音频先传到公网某个地址：

1. **声音复刻**：`POST https://api.elevenlabs.io/v1/voices/add`
   （multipart/form-data，直接把上传的音频文件转发过去，返回 `voice_id`）
2. **语音合成**：`POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`
   （JSON 请求，直接返回音频二进制数据，后端原样转发给前端）

鉴权用的是 `xi-api-key` 这个请求头（不是常见的 `Authorization: Bearer`），
代码里已经处理好了，不需要你关心这个细节。

⚠️ 第三方 API 的接口细节偶尔会更新，如果调用报错，对照最新官方文档核对：
- https://elevenlabs.io/docs/api-reference/voices/ivc/create
- https://elevenlabs.io/docs/api-reference/text-to-speech/convert

---

## 一、本地运行

### 1. 启动后端

需要先安装 [Node.js](https://nodejs.org/)（18 或以上版本）。

```bash
cd backend
npm install
npm start
```

看到下面的输出说明后端启动成功：

```
✅ 后端已启动，正在监听端口 3001
   本地测试地址：http://localhost:3001/api/health
```

用浏览器打开 `http://localhost:3001/api/health`，看到 `{"status":"ok"}` 即可。

### 2. 打开前端

`frontend/index.html` 是纯静态文件，本地调试时**不需要任何构建步骤**，
用浏览器直接双击打开，或者用编辑器（如 VS Code）的 Live Server 插件打开都可以。

打开后：
1. 填入你的 ElevenLabs API Key（在 ElevenLabs 后台「Profile → API Keys」里获取）
2. 上传一段 5–20 秒的清晰人声音频
3. 输入要合成的文字
4. 点击「生成语音」

首次生成会稍慢一些（需要先完成声音复刻），之后只要不换音频文件，
每次点生成都会直接复用同一个音色，速度会快很多。

---

## 二、部署到云端

整体思路：**后端部署到 Render（或 Railway），前端部署到 Vercel**。
之所以分开部署，是因为后端需要常驻进程运行 Node.js，而前端只是静态文件。

### 第一步：把代码推到 GitHub

Render / Vercel 都支持"连接 GitHub 仓库自动部署"，最省心。把整个 `voice-clone-mvp` 文件夹
初始化成一个 Git 仓库并推送到你自己的 GitHub 账号下（如果你还不熟悉 Git，也可以用 GitHub
网页的 "Add file → Upload files" 功能，逐个文件夹拖拽上传）。

```bash
cd voice-clone-mvp
git init
git add .
git commit -m "init: voice clone MVP"
# 在 GitHub 上新建一个空仓库后，替换成你自己的仓库地址
git remote add origin https://github.com/你的用户名/voice-clone-mvp.git
git push -u origin main
```

### 第二步：部署后端到 Render

1. 打开 [render.com](https://render.com)，用 GitHub 账号登录。
2. 点击 **New +** → **Web Service**。
3. 选择你刚才推送的仓库。
4. 关键配置：
   - **Root Directory**：`backend`（因为后端代码在这个子目录里）
   - **Runtime**：Node
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：免费的 Free 档位即可满足 MVP 测试需求
5. 环境变量：不需要额外配置（API Key 是前端每次请求时传过来的）。
6. 点击 **Create Web Service**，等待几分钟部署完成。
7. 部署成功后，页面上会显示一个形如 `https://voice-clone-backend-xxxx.onrender.com` 的地址，
   这就是你的后端地址。用浏览器打开 `这个地址/api/health` 确认能看到 `{"status":"ok"}`。

> 免费档位的 Render 服务在长时间没有请求时会"休眠"，下次请求时需要几十秒唤醒，属于正常现象，
> MVP 阶段可以先忍一下；后续如果要正式使用，升级到付费档位即可解决。

### 备选：部署后端到 Railway

1. 打开 [railway.app](https://railway.app)，用 GitHub 账号登录。
2. **New Project** → **Deploy from GitHub repo**，选择你的仓库。
3. 在项目设置里把 **Root Directory** 设置为 `backend`。
4. Railway 会自动识别 Node.js 项目，自动执行 `npm install` + `npm start`，一般不需要手动配置。
5. 部署完成后，在 **Settings → Networking** 里点 **Generate Domain**，拿到一个公网可访问的地址。

### 第三步：修改前端里的后端地址

打开 `frontend/index.html`，找到这一行（在 `<script>` 标签靠前的位置）：

```javascript
const API_BASE = "http://localhost:3001";
```

把它改成你上一步拿到的 Render（或 Railway）后端地址，注意**不要带最后的斜杠 `/`**，例如：

```javascript
const API_BASE = "https://voice-clone-backend-xxxx.onrender.com";
```

### 第四步：部署前端到 Vercel

**方式 A：网页拖拽（最简单，不需要装任何工具）**

1. 打开 [vercel.com](https://vercel.com)，登录。
2. 点击 **Add New** → **Project** → 选择 **Deploy without Git**（或类似的"直接上传"入口）。
3. 把 `frontend` 文件夹（里面只有一个 `index.html`）拖进去上传。
4. 等待几十秒，Vercel 会给你一个形如 `https://your-project.vercel.app` 的地址，打开即可使用。

**方式 B：连接 GitHub 仓库自动部署**

1. 打开 [vercel.com](https://vercel.com) → **Add New** → **Project** → 选择你的 GitHub 仓库。
2. **Root Directory** 设置为 `frontend`。
3. Framework Preset 选择 **Other**（纯静态 HTML，不需要构建命令）。
4. 点击 **Deploy**，完成后同样会拿到一个 `.vercel.app` 的访问地址。

以后你只要 `git push`，Vercel 就会自动重新部署最新的前端代码。

---

## 三、常见问题排查

| 现象 | 可能原因 / 处理方式 |
|---|---|
| 前端点"生成语音"后一直报网络错误 | 检查 `index.html` 里的 `API_BASE` 是否已经改成了 Render/Railway 的真实地址，而不是 `localhost` |
| 报错 `401` / `invalid_api_key` | API Key 填错了，或者这个 Key 已经被删除/禁用，去 ElevenLabs 后台重新生成一个 |
| 报错和 `quota_exceeded` / 额度相关 | 免费额度（每月 10,000 字符）用完了，去账户设置查看用量，或升级付费档位（Starter $6/月起） |
| 报错 `voice_not_found` | 传的 `voiceId` 不对，可能是缓存的音色已经在 ElevenLabs 后台被删除了，重新上传音频复刻一次 |
| 声音复刻报错、提示音频问题 | 检查音频格式（wav/mp3/m4a）、时长（建议 1–5 分钟内，几秒到二十秒也可以）、文件大小（≤10MB） |
| Render 上的后端第一次请求特别慢 | 免费档位休眠唤醒导致，等它启动完就恢复正常了 |
| 想确认后端本身有没有问题 | 直接用浏览器打开 `你的后端地址/api/health`，能看到 `{"status":"ok"}` 说明后端本身没问题，问题出在前端配置或 ElevenLabs 那一侧 |

---

## 四、关于安全性的说明

- API Key 只存在你当前浏览器标签页的内存里（一个 JS 变量），刷新页面就会清空，**不会**写入
  cookie、localStorage，也不会出现在任何日志文件里。
- Key 会通过 HTTPS 从浏览器发送到你自己部署的后端，再由后端转发给 ElevenLabs——这一跳是必须的，
  因为浏览器无法直接跨域调用第三方接口。只要你的 Render/Vercel 部署都是默认的 HTTPS
  （两个平台都默认开启），这个过程是加密的。
- 这版后端是完全开放的（没有登录、没有限流），任何拿到你后端地址的人理论上都可以拿着**他们自己的**
  API Key 来调用你的转发接口——但因为 Key 是调用方自己传的，不会消耗你的 ElevenLabs 额度，风险主要是
  "被人白嫖你的服务器算力"。如果要长期使用，建议后续加一层简单的访问口令或限流。

---

## 五、扩展方向

- **音色管理**：ElevenLabs 支持查询音色列表、删除音色、查看订阅用量，可以在后端再加几个接口，
  前端做一个"我的音色库"页面，省去每次都要重新上传参考音频。
- **调节音色参数**：`text-to-speech` 接口支持 `voice_settings`（稳定性 stability、相似度
  similarity_boost 等），可以加几个滑块给用户微调，让合成效果更贴近原声。
- **流式合成**：换成 `/v1/text-to-speech/{voice_id}/stream` 这个接口，可以实现"边生成边播放"，
  减少长文本的等待时间。
- **换更专业的克隆**：ElevenLabs 除了这版用的 Instant Voice Cloning（即时克隆，几秒钟出结果），
  还有 Professional Voice Cloning（需要更长的样本、有审核流程，但音色质量更高），适合正式产品阶段。
- **鉴权与限流**：给自己的后端加一个简单的访问密码或者基于 IP 的限流，避免被陌生人白嫖。
- **自建开源模型**：如果之后想完全去中心化、不依赖任何第三方 API，可以换成本地部署的开源方案
  （如 XTTS-v2、OpenVoice），需要一台带 GPU 的服务器，架构会更复杂。

---

## 六、更新记录

- **v1**：基于阿里云百炼 Qwen-TTS（`qwen3-tts-vc-2026-01-22`），简单 HTTP 接口。
- **v2**：因模型访问权限问题，改用阿里云 Qwen-Audio-TTS（`qwen-audio-3.0-tts-plus`），
  语音合成部分改为 WebSocket 协议（新加坡地域下该模型系列的非实时接口不可用）。
- **v3（当前版本）**：声音复刻功能在阿里云账号上一直卡在 `AccessDenied.Unpurchased`
  （账号权限未开通，客服回复不明确），改用 **ElevenLabs**——自助式服务，注册即用，
  不需要审核。架构也因此简化回最初的"纯 HTTP 请求/响应"，去掉了 WebSocket 和
  Workspace ID 相关的配置。
