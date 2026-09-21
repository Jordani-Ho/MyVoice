# 声音工坊 · 个人声音克隆与语音合成（MVP）

一个基于阿里云百炼（Model Studio，新加坡节点）Qwen-TTS 声音复刻能力的最小可用产品：
上传一段 5–20 秒的参考音频，克隆出专属音色，再用这个音色朗读任意文字。

---

## 目录结构

```
voice-clone-mvp/
├── backend/                 后端：Node.js + Express
│   ├── server.js            核心代码（含详细中文注释）
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
├── frontend/                 前端：纯 HTML / CSS / JS 单文件
│   └── index.html
└── README.md                 本文档
```

---

## 技术选型说明（请务必先看这一段）

需求里提到的域名 `https://ws-xxxxxxxx.ap-southeast-1.maas.aliyuncs.com` 是你的百炼工作空间
专属域名，通常用于 **CosyVoice** 的实时语音合成，走的是 WebSocket 长连接协议。

本项目最终选择的是另一条更适合"网页 MVP"的路线：**Qwen-TTS 声音复刻**。原因：

| 对比项 | CosyVoice（你提供的域名） | Qwen-TTS（本项目采用） |
|---|---|---|
| 合成协议 | WebSocket 长连接 | 标准 HTTP POST |
| 上传参考音频 | 需要先传到 OSS，拿公网 URL | 可直接传 Base64，前端选完文件即可用 |
| 是否需要 Workspace ID | 需要 | 不需要 |
| Node.js 实现复杂度 | 较高 | 低，适合 MVP |

也就是说，你提供的域名在这版代码里**没有被直接使用**——这是特意做出的技术选型，不是遗漏。
如果之后想换成 CosyVoice（比如想要更多方言音色、或者想做实时打字实时出声的效果），
可以参考文末「扩展方向」一节。

后端调用的两个阿里云接口是：

1. **声音复刻**：`POST https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization`
2. **语音合成**：`POST https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`

⚠️ 阿里云的接口细节、模型名（代码里的 `qwen3-tts-vc-2026-01-22`）会不定期更新，
如果实际调用报错提示"模型不存在"或"参数不合法"，请对照百炼控制台的最新文档核对：
- https://www.alibabacloud.com/help/zh/model-studio/voice-cloning-user-guide
- https://www.alibabacloud.com/help/zh/model-studio/non-realtime-tts-user-guide

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
1. 填入你的阿里云百炼 API Key（新加坡节点）
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
初始化成一个 Git 仓库并推送到你自己的 GitHub 账号下（如果你还不熟悉 Git，也可以用 Render /
Vercel 的"直接拖拽上传"功能，见下面的备选说明）。

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
| 报错 `HTTP 401` / `InvalidApiKey` | API Key 填错了，或者用错了地域的 Key（新加坡节点和北京节点的 Key 不通用） |
| 报错和"配额""Quota"相关 | 免费额度用尽，去百炼控制台查看用量，或开通付费 |
| 报错"音频不合规" / `Audio.*` | 检查音频格式（wav/mp3/m4a）、时长（建议 5–20 秒，最长不超 60 秒）、文件大小（≤10MB） |
| Render 上的后端第一次请求特别慢 | 免费档位休眠唤醒导致，等它启动完就恢复正常了 |
| 想确认后端本身有没有问题 | 直接用浏览器打开 `你的后端地址/api/health`，能看到 `{"status":"ok"}` 说明后端本身没问题，问题出在前端配置或阿里云那一侧 |

---

## 四、关于安全性的说明

- API Key 只存在你当前浏览器标签页的内存里（一个 JS 变量），刷新页面就会清空，**不会**写入
  cookie、localStorage，也不会出现在任何日志文件里。
- Key 会通过 HTTPS 从浏览器发送到你自己部署的后端，再由后端转发给阿里云——这一跳是必须的，
  因为浏览器无法直接跨域调用阿里云接口。只要你的 Render/Vercel 部署都是默认的 HTTPS
  （两个平台都默认开启），这个过程是加密的。
- 这版后端是完全开放的（没有登录、没有限流），任何拿到你后端地址的人理论上都可以拿着**他们自己的**
  API Key 来调用你的转发接口——但因为 Key 是调用方自己传的，不会消耗你的阿里云额度，风险主要是
  "被人白嫖你的服务器算力"。如果要长期使用，建议后续加一层简单的访问口令或限流。

---

## 五、扩展方向

- **换成 CosyVoice**：如果想用更丰富的中文方言音色，或者想做打字实时出声的效果，需要改用
  WebSocket 协议对接 `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference`，
  后端要引入 `ws` 这样的 WebSocket 客户端库，复杂度会明显上升。
- **音色管理**：阿里云支持查询音色列表、查看音色详情、删除音色，可以在后端再加几个接口，
  前端做一个"我的音色库"页面，省去每次都要重新上传参考音频。
- **流式合成**：把 `stream: false` 改成流式模式，可以实现"边生成边播放"，减少长文本的等待时间，
  但前端播放逻辑要相应改成处理分段的 Base64 音频数据。
- **鉴权与限流**：给自己的后端加一个简单的访问密码或者基于 IP 的限流，避免被陌生人白嫖。
