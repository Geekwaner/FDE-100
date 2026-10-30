# FDE 案例 100 · 阅读版

Datawhale《FDE案例100》的静态阅读站点。纯 HTML / CSS / JavaScript，**没有构建依赖、没有 CDN、没有外链字体**，直接托管在 GitHub Pages 上。

- 仓库：https://github.com/Geekwaner/FDE-100
- 站点：https://geekwaner.github.io/FDE-100/

## 站点结构

| 路径 | 内容 |
| --- | --- |
| `index.html` | 首页：24 个案例卡片、按行业筛选、全站搜索入口 |
| `cases/no-XX.html` | 单个案例详情：案例简介、适用人群、Q1–Q6 六个问答、上下篇导航 |
| `chat.html` | AI 问答：自建聊天界面 + 流式输出，调用自建 Mastra Agent 服务（向量检索案例库） |
| `appendix.html` | 附录 A 案例索引 + 附录 B 前言 |
| `all.html` | 24 个案例全文单页版（适合 Ctrl+F 与打印） |
| `404.html` | GitHub Pages 自定义 404 |
| `assets/` | 样式、交互脚本、检索索引（`search-index.js`，按需加载） |

全站搜索支持 `Ctrl / Cmd + K`（`/` 也可以），中文按二元组匹配，结果按内容相关度排序并高亮命中词。

## 本地预览

```powershell
cd Datawhale-FDE
python build_site.py                      # 由 Markdown 重新生成站点
node tools/build-agent-index.mjs          # 生成问答用的向量索引（改过案例内容才需要）
cd cloudrun/agent && npm install && npm start   # 起问答服务（端口 8080）
python -m http.server 8787                # 另开一个终端，预览静态站
```

问答页会直接请求云托管地址；本地调试可把 `site.config.json` 的 `chatApiBase` 临时改成 `http://127.0.0.1:8080/api/chat`，并在 `.env` 里加 `ALLOW_ORIGIN` 包含 `http://127.0.0.1:8787`。

## AI 问答：架构

```
浏览器（静态站，无密钥）
   │  POST /api/chat  { query, conversation_id }
   ▼
fde-agent（CloudBase 云托管容器：Mastra + Express）
   ├─ 硅基流动 embedding → 与内置 168 个案例块的向量算余弦 → top-k
   ├─ Mastra Agent（Qwen3.8-27B，关思考）读片段生成答案
   └─ 以「Dify 兼容 SSE」回写：message / message_end / retriever_resources
   ▼
浏览器逐字渲染 + 引用案例标签（NO.x → cases/no-XX.html）
```

**前端 `assets/chat.js` 一行没改**——服务端刻意实现了 Dify 的事件协议，所以换引擎对界面零影响。

| 组件 | 位置 | 说明 |
| --- | --- | --- |
| **Agent 服务（当前线上）** | `cloudrun/agent/` | Mastra + Express + 向量检索 + 三层限流；首段可见 0.9–1.2s |
| 索引构建 | `tools/build-agent-index.mjs` | 168 块（24 简介 + 144 问答）× 1024 维，产物入库随镜像打包 |
| 冒烟脚本 | `tools/test-agent-e2e.py` | 五类问题 + 多轮指代，本地/线上都能跑 |
| Dify 代理（回退） | `cloudrun/dify-proxy/` | 老的 Dify 转发，服务没删，改 `site.config.json` 即可切回 |
| 云函数版（备胎） | `cloudfunctions/dify-proxy/` | 无 SSE，7–16s 整段返回 |
| 其它代理 | `server/proxy.mjs`、`worker/index.js` | VPS / Cloudflare 备用 |

### 部署 Agent 服务

环境 `innovative-bass-d0f4jspo82b42e21`（ap-shanghai，Trial），服务名 `fde-agent`：

- 容器：`node:20-alpine` 多阶段构建，只留 `node_modules` + `src` + `data`
- 规格 1 核 / 2G，`MinNum=0`、`MaxNum=2`，端口 8080
- 环境变量：`SILICONFLOW_API_KEY` / `SILICONFLOW_BASE_URL` / `SILICONFLOW_MODEL` / `SILICONFLOW_EMBEDDING_MODEL` / `ALLOW_ORIGIN` / 三个限流变量
- 地址：`https://fde-agent-337606-12-1310552826.sh.run.tcloudbase.com`，健康检查 `…/health`
- 重新部署：MCP `manageCloudRun action=deploy`（或 `tcb cloudrun deploy fde-agent --path cloudrun/agent`）

**回退到 Dify**：把 `site.config.json` 的 `chatApiBase` 改成 `https://dify-proxy-337606-12-1310552826.sh.run.tcloudbase.com/api/chat`，重跑 `python build_site.py` 提交即可（`chatFallback` 字段里也留了这条地址）。

**限流**（防额度被刷，两个服务共用同一套变量与语义）：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `RATE_LIMIT_PER_MIN` | 20 | 每 IP 每分钟提问次数 |
| `RATE_LIMIT_PER_DAY` | 100 | 每 IP 每天提问次数 |
| `GLOBAL_DAILY_CAP` | 500 | 全站每天总次数 |

超限返回 `429` + `Retry-After` 秒数，前端直接把服务端文案显示给用户（"提问有点频繁，请 N 秒后再试"）。任一设为 `0` 即关闭该项。计数在单实例内存里，**冷启动/扩容会重置**——用于挡滥用足够，要精确配额得换 Redis。

**Dify 相关备选**（都已部署过，保留作为回退链路）：

- `cloudrun/dify-proxy/`：云托管容器版 Dify 转发，SSE 正常，地址见 `site.config.json` 的 `chatFallback`
- `cloudfunctions/dify-proxy/`：云函数 + HTTP 网关版，无 SSE（7–16s 整段返回）
- `server/proxy.mjs`：本地 / VPS 版，`DIFY_KEY=app-xxxx ALLOW_ORIGIN=… PORT=8787 node server/proxy.mjs`
- `worker/index.js`：Cloudflare Worker 版

### 指向前端

问答地址写在 **`site.config.json`**（已入库，改完直接 `python build_site.py` 生效）：

```json
{
  "chatApiBase": "https://fde-agent-337606-12-1310552826.sh.run.tcloudbase.com/api/chat",
  "chatFallback": "https://dify-proxy-337606-12-1310552826.sh.run.tcloudbase.com/api/chat"
}
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
