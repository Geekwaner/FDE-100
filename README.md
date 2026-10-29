# FDE 案例 100 · 阅读版

Datawhale《FDE案例100》的静态阅读站点。纯 HTML / CSS / JavaScript，**没有构建依赖、没有 CDN、没有外链字体**，直接托管在 GitHub Pages 上。

- 仓库：https://github.com/Geekwaner/FDE-100
- 站点：https://geekwaner.github.io/FDE-100/

## 站点结构

| 路径 | 内容 |
| --- | --- |
| `index.html` | 首页：24 个案例卡片、按行业筛选、全站搜索入口 |
| `cases/no-XX.html` | 单个案例详情：案例简介、适用人群、Q1–Q6 六个问答、上下篇导航 |
| `chat.html` | AI 问答：自建聊天界面 + 流式输出，走自建代理调用 Dify 后端 API |
| `appendix.html` | 附录 A 案例索引 + 附录 B 前言 |
| `all.html` | 24 个案例全文单页版（适合 Ctrl+F 与打印） |
| `404.html` | GitHub Pages 自定义 404 |
| `assets/` | 样式、交互脚本、检索索引（`search-index.js`，按需加载） |

全站搜索支持 `Ctrl / Cmd + K`（`/` 也可以），中文按二元组匹配，结果按内容相关度排序并高亮命中词。

## 本地预览

```powershell
cd Datawhale-FDE
python build_site.py          # 由 Markdown 重新生成站点
node server/proxy.mjs         # 起站 + 问答代理，打开 http://127.0.0.1:8787/
```

`server/proxy.mjs` 同时托管静态站点并代理 `/api/chat`，本地与线上同源，问答可以直接用。纯静态预览（不含问答）也可以 `python -m http.server 8765`，但 `file://` 下检索索引会因浏览器安全策略加载失败。

## AI 问答：为什么需要一个后端

静态站不能持有 `app-xxxx` 这类 Dify API Key——仓库是公开的，写进 JS 等于把额度送人。所以链路拆成两段：

```
浏览器  ──POST /api/chat──▶  自建代理（持 Key）──▶  https://api.dify.ai/v1/chat-messages
   ▲                                                          │
   └──────────────── SSE 流式回传（逐字渲染）──────────────────┘
```

- 前端：`assets/chat.js`，SSE 逐字渲染、多轮记忆（`conversation_id`）、停止生成、引用来源链回案例页、自动过滤 deepseek 的 `<think>` 思考过程
- 代理：只做三件事——藏 Key、加 CORS、透传 SSE。仓库里有四份实现，按部署环境挑一份：

| 实现 | 位置 | 流式 | 说明 |
| --- | --- | --- | --- |
| **云托管容器（当前线上）** | `cloudrun/dify-proxy/` | ✅ SSE | 容器自己 `res.write()`，真流式；实测首字节 3.9s、首段回答 11.3s、总 15.9s |
| 云函数 + HTTP 网关 | `cloudfunctions/dify-proxy/` | ❌ 缓冲 | 走 `blocking`，7–16s 整段返回；留着做降级备胎 |
| Node 自建 | `server/proxy.mjs` | ✅ SSE | VPS / 本机，顺带托管静态站 |
| Cloudflare Worker | `worker/index.js` | ✅ SSE | 免费，workers.dev 国内不稳 |

### 部署代理

**当前线上：CloudBase 云托管（容器型）**

环境 `innovative-bass-d0f4jspo82b42e21`（ap-shanghai，Trial），服务名 `dify-proxy`：

- 规格 0.25 核 / 0.5G，`MinNum=0`（无请求时缩容到 0，省钱；代价是冷启动）
- 端口 8080，环境变量 `DIFY_API_KEY` / `DIFY_API_BASE` / `ALLOW_ORIGIN`
- 地址：`https://dify-proxy-337606-12-1310552826.sh.run.tcloudbase.com`
- 健康检查：`…/health`

重新部署（改完 `cloudrun/dify-proxy/` 里的代码后）：

```powershell
# 在 Claude/CodeBuddy 里让 MCP 执行即可，等价 CLI 命令：
# tcb cloudrun deploy dify-proxy -e innovative-bass-d0f4jspo82b42e21 --path cloudrun/dify-proxy
```

**备选 A：自己的服务器**

```bash
DIFY_KEY=app-xxxx ALLOW_ORIGIN=https://geekwaner.github.io PORT=8787 node server/proxy.mjs
```

systemd/pm2 常驻，nginx 反代务必关缓冲：`proxy_buffering off; proxy_read_timeout 300s;`

**备选 B：Cloudflare Worker**

```bash
npx wrangler login
npx wrangler secret put DIFY_API_KEY --config worker/wrangler.toml
npx wrangler deploy --config worker/wrangler.toml
```

### 指向前端

代理地址写在 **`site.config.json`**（已入库，改完直接 `python build_site.py` 生效）：

```json
{ "chatApiBase": "https://dify-proxy-337606-12-1310552826.sh.run.tcloudbase.com/api/chat" }
```

优先级：环境变量 `CHAT_API_BASE` > `site.config.json` > 默认 `/api/chat`（同源，适合 `server/proxy.mjs`）。

> 用配置文件而不是纯环境变量，是为了防止"随手 `python build_site.py` 一次，把线上地址覆盖回默认值"——这个坑真的踩过一次。

> `.env` 里放 `Dify_key=app-xxxx` 仅供本地/服务器使用，已在 `.gitignore` 中，不会进仓库。如果 Key 曾经出现在提交历史或截图里，去 Dify 后台重置。

完整的技术方案、协议细节、安全边界与踩坑清单见 **[docs/ai-integration.md](docs/ai-integration.md)**（含约 2 分钟的面试讲述版）。

## 部署到 GitHub Pages

仓库已推到 `main`，Pages 只需在网页上开启一次（Settings 无法用 git 命令设置）：

1. 打开 https://github.com/Geekwaner/FDE-100/settings/pages
2. **Source** 选 `Deploy from a branch`
3. **Branch** 选 `main`，目录选 `/ (root)`，Save
4. 等 1–2 分钟，访问 https://geekwaner.github.io/FDE-100/

之后每次 `git push` 到 `main`，Pages 会自动重新发布，不需要额外配置 CI。

> 站点根目录已放 `.nojekyll`，跳过 Jekyll 处理；所有链接都是相对路径，所以放在子路径（`/FDE-100/`）下也不会出错。如果以后要绑自定义域名，在 Pages 设置里填域名即可，不用改代码。

## AI 问答（Dify 嵌入）

`chat.html` 用 `<iframe>` 内嵌 Dify 的聊天机器人，地址在 `build_site.py` 的 `CHAT_URL` 常量里，换应用只改这一处：

```python
CHAT_URL = "https://udify.app/chatbot/uebvgPRnJKxeb3eY"
```

交互做了三件事：

- 页面铺满视口（`calc(100dvh - 页头高度)`），不再嵌套滚动条
- 加载遮罩 + 12 秒后提示「可直接在新窗口打开」——`udify.app` 的 JS 分包较大，实测单个 chunk 在慢网络下要几十秒
- 站内其它入口：首页「向 AI 提问」按钮、每个案例页底部「直接问 AI」

> 如果 Dify 那边换了域名（如 `cloud.dify.ai`）或应用重新发布，同步改 `CHAT_URL` 后重跑 `build_site.py` 即可。
> 想换成右下角悬浮气泡样式，Dify 也提供 `embed.min.js` 方式，可以按需替换。

## 内容更新流程

```
Datawhale-FDE案例100-纯文字.md          # 原始纯文字版（PDF 转换而来）
        │  python prepare_rag_doc.py
        ▼
Datawhale-FDE案例100-纯文字-RAG版.md    # RAG 优化版（去噪 + 案例身份注入）
        │  python build_site.py
        ▼
index.html / cases/*.html / appendix.html / all.html / assets/search-index.js
```

改了 Markdown 之后重跑这两个脚本，再提交生成的 HTML 即可。

- `prepare_rag_doc.py`：清理目录、图注、编辑备注，修正错位标签，给每个问答标题注入案例标识（同时也作为 Dify 等 RAG 系统的知识库文档）。
- `build_site.py`：解析 Markdown，生成静态页面与检索索引。

## 版权

内容版权归 Datawhale 及各位讲述人所有，本仓库为非官方阅读版，仅供学习交流。
