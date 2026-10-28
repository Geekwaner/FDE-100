# AI 接入技术说明

记录本站把 Dify 知识库问答接进一个纯静态站点（GitHub Pages）的完整技术方案：架构取舍、协议细节、安全边界、踩坑与遗留问题。

对应代码：`assets/chat.js`（前端）、`cloudfunctions/dify-proxy/`（线上代理）、`server/proxy.mjs`（自建备选）、`worker/index.js`（Cloudflare 备选）。

---

## 1. 架构：为什么必须是三段式

静态站不能持有 `app-xxxx` 这类 Dify API Key —— 仓库公开，写进 JS 等于把额度送人；浏览器开发者工具里也一眼可见。所以链路拆成三段，每段职责单一、可独立替换：

```
浏览器（静态站，无密钥）
   │  POST JSON {query, conversation_id, user}
   ▼
代理层：CloudBase 云函数 dify-proxy（持 Key）
   │  Authorization: Bearer app-xxx
   ▼
Dify 后端 API  /v1/chat-messages
   │  知识库检索 → LLM 生成
   ▼
返回 answer + metadata.retriever_resources
```

| 层 | 职责 | 可替换性 |
| --- | --- | --- |
| 前端 `chat.js` | 交互、渲染、会话状态 | 只认 `data-api` 一个地址 |
| 代理 | 藏 Key、CORS、透传/整形响应 | Node / Worker / 云函数三份实现 |
| Dify | 检索与生成 | 换应用只改服务端 Key |

**放弃的第一版**：先用 Dify 官方 `<iframe src="https://udify.app/chatbot/...">`。功能正常，但 `udify.app`（Dify 早期云域名）在国内极慢，实测单个 JS 分包约 58 秒，页面空白转圈近一分钟。这是域名/网络问题，不是嵌入写法问题——所以彻底换成自建界面 + 后端 API。

---

## 2. Dify API 用法

| 端点 / 参数 | 用途 |
| --- | --- |
| `GET /v1/parameters` | 连接性探测，顺带取开场白、建议问题（比直接发问省额度） |
| `POST /v1/chat-messages` | 主对话接口 |
| `query` | 用户问题 |
| `conversation_id` | 多轮记忆：传上一轮 `message_end` 里返回的 id，Dify 侧自动拼接上下文 |
| `user` | 调用方标识，按用户隔离会话与统计 |
| `response_mode` | `streaming`（SSE 逐字）/ `blocking`（一次性 JSON） |
| `inputs` | 应用定义的变量，本项目为空对象 |
| `metadata.retriever_resources[]` | 引用来源：`document_name`、`content`（命中分块原文）、`score` |
| `metadata.usage` | token 用量，可用于成本统计（当前未采集） |

**推理模型输出格式**：deepseek 会把思考过程包在 `<think>…</think>` 与 `<!--dify-deepseek-reasoning-->` 注释中一起塞进 `answer`。必须在前端剥离，否则用户会看到"用户问的是……"这种内部独白。

---

## 3. 传输层

### 3.1 SSE 流式解析

```js
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
// 按 \n\n 切事件块，逐行识别 data: 前缀
```

事件与处理：

| 事件 | 处理 |
| --- | --- |
| `workflow_started` / `node_started` | 显示「正在检索案例库…」 |
| `message` / `agent_message` | 追加 `answer` 片段，增量重渲染 |
| `message_end` | 收 `conversation_id` 与 `retriever_resources` |
| `error` | 抛错，展示可读提示 |

### 3.2 双模式自适应（本项目最关键的一处设计）

云函数所在平台会把响应整体缓冲，拿不到 SSE。前端不写两套，而是看 `content-type` 决定渲染方式：

```js
const ctype = res.headers.get('content-type') || '';
if (ctype.indexOf('text/event-stream') === -1) {
  // 一次性 JSON：整段渲染
  const data = await res.json();
} else {
  // SSE：逐字渲染
}
```

结果是：**同一个前端，既能跑支持 SSE 的自建代理，也能跑被缓冲的云函数**；哪天换成自建服务器，只改 `CHAT_API_BASE` 重建一次，前端代码一行不动。

### 3.3 代理侧反缓冲

SSE 被中间层攒成一坨的典型原因：反向代理/Nginx/CDN 缓冲。代理必须显式声明：

```js
res.writeHead(200, {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
});
Readable.fromWeb(upstream.body).pipe(res);
```

Nginx 侧还需要 `proxy_buffering off; proxy_read_timeout 300s;`。

### 3.4 其它传输细节

- **CORS**：`Access-Control-Allow-Origin` 按白名单回显具体来源（不是 `*`），配 `Vary: Origin`；`OPTIONS` 预检返回 204
- **中断**：`AbortController` 中断请求，客户端保留已生成文本并标注「已停止生成」
- **超时**：云函数 60s（实测 7–16s 返回），Node 代理不设上限但 Nginx 读超时 300s

---

## 4. 安全边界

| 风险 | 处理 | 位置 |
| --- | --- | --- |
| 密钥进仓库 | `.env` 进 `.gitignore`；只保留 `.env.example` | 仓库根 |
| 密钥进前端 | 前端零密钥，只有 `data-api` 地址 | `chat.js` |
| 额度被盗刷 | 代理侧 CORS 白名单；可选限流（内存分钟计数 / 网关 perClient QPS） | 代理 |
| XSS | 模型输出先 `escape` 再按 Markdown 渲染，不直传 `innerHTML` | `chat.js` |
| 越权 | 云函数只做转发，不接数据库、不暴露其它能力 | `cloudfunctions/` |
| Key 曾出现在对话/截图 | 建议到 Dify 后台重置，改环境变量即可，无需重新部署代码 | — |

---

## 5. 前端交互技术

| 技术点 | 说明 |
| --- | --- |
| 增量渲染 | 每个 chunk 重新渲染累积文本，形成打字机效果 |
| 思考过程过滤 | 正则剥 `<think>` 块，并处理"尚未闭合"的中间态（思考中不显示，避免闪烁与截断） |
| 轻量 Markdown | 自写约 30 行：段落、有序/无序列表、`**粗体**`、行内代码；先转义后渲染 |
| 引用可点击 | 从 `retriever_resources[].content` 正则提取 `NO.x` → 链到 `cases/no-XX.html`；提取不到则退化为从答案正文提取 |
| 会话持久化 | `sessionStorage` 存消息与 `conversation_id`，刷新不丢；隐私模式静默失败 |
| 输入法兼容 | Enter 发送 / Shift+Enter 换行，且判断 `e.isComposing` —— 否则中文选词时按回车会误发送 |
| 状态机 | `busy` 期间隐藏发送、显示停止、禁用输入；异常分支区分「服务不可用」与「业务报错」 |
| 静态资源指纹 | `app.js?v=<md5 前 8 位>`，JS/CSS 一变 URL 就变，避免用户吃到旧缓存 |

---

## 6. 平台适配踩坑清单

| 现象 | 根因 | 解法 |
| --- | --- | --- |
| 官方聊天页空白转圈近 60s | `udify.app` 旧域名分包极慢（58s/chunk） | 放弃 iframe，改自建界面调后端 API |
| 建 HTTP 函数报 `ResourceNotFound.Entryfile ... scf_bootstrap` | CloudBase `type:HTTP` 是 Web 函数模型，需启动脚本 | 改用 `type:Event` + HTTP 网关路由 |
| 网关建好访问 403 `HTTPSERVICE_NONACTIVATED` | 网关总开关未开 | `enableService` |
| 云函数收到 `?????` | PowerShell `Invoke-RestMethod` 默认编码把中文压成问号 | 显式 `[Text.Encoding]::UTF8.GetBytes()` |
| 回答里出现"用户问的是…" | 推理模型思考过程混入 `answer` | 前端剥离 `<think>` |
| 引用标签只有整本文档名 | `document_name` 是文档名，不含案例编号 | 改从 `content` 分块提取 `NO.x` |
| 首页行业筛选点击无反应 | `.card { display:flex }` 盖掉 UA 的 `[hidden]{display:none}`，JS 设了 `hidden` 也不生效 | `.cards .card[hidden] { display:none }` |

最后一条与 AI 无关，但属于同一类问题：**"逻辑执行了但界面没变"时，先查 CSS 优先级，别急着怀疑 JS。**

---

## 7. 当前取舍

| 维度 | 现状 | 说明 |
| --- | --- | --- |
| 流式输出 | ❌ 线上无 | CloudBase HTTP 访问服务不支持 SSE，走 `blocking`，7–16s 整段返回 |
| 首字延迟 | 5–16s | 主要耗在知识库检索 + deepseek 推理 |
| 限流 | ⚠️ 未启用 | 网关 `perClient` QPS 或函数内 IP 计数，二选一即可 |
| 用户体系 | ❌ 无 | 全员共用 `user=web`，Dify 侧不区分人 |
| 成本统计 | ❌ 无 | `message_end.metadata.usage` 可落库统计 |

**升级路径**：把代理换到自己的服务器（`server/proxy.mjs`，原生支持 SSE）→ 前端自动切回流式；再补用户标识与限流，即可对外小规模开放。

---

## 8. 面试讲述版（约 2 分钟）

**背景**：把 Datawhale 的《FDE 案例100》做成可检索的阅读站，并接上基于这套内容的 AI 问答。

**任务**：静态站没有后端，但要做「基于知识库的问答」，同时不能把 API Key 暴露在公开仓库。

**行动**：
1. 先用官方 iframe 快速验证可行性，实测发现数据源域名在国内要 60 秒才出界面——判定为网络问题而非实现问题，果断换方案。
2. 设计三段式：静态站（无密钥）→ 自建代理（持密钥、管 CORS）→ Dify 后端 API（检索+生成）。
3. 前端自己实现 SSE 解析、增量渲染、多轮记忆（`conversation_id`）、引用溯源（从检索分块里提取案例编号并回链原文）、以及推理模型思考过程的过滤。
4. 遇到平台不支持 SSE 时，用 `content-type` 做双模式自适应，一套前端同时兼容流式与一次性返回，避免绑定某个部署平台。
5. 安全上坚持密钥不进前端、不进 git，代理白名单 + 可选限流。

**结果**：问答页从"空白 60 秒"变成 7–16 秒出答案并带可点击引用；换部署平台时前端零改动。

**如果重做**：优先把代理放在支持 SSE 的环境（省掉双模式分支）；同时从第一版就接上 `usage` 统计与限流，避免上线后再补。
