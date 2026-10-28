# FDE 案例 100 · 阅读版

Datawhale《FDE案例100》的静态阅读站点。纯 HTML / CSS / JavaScript，**没有构建依赖、没有 CDN、没有外链字体**，可以直接托管在 GitHub Pages 的 `用户名.github.io/仓库名` 路径下。

## 站点结构

| 路径 | 内容 |
| --- | --- |
| `index.html` | 首页：24 个案例卡片、按行业筛选、全站搜索入口 |
| `cases/no-XX.html` | 单个案例详情：案例简介、适用人群、Q1–Q6 六个问答、上下篇导航 |
| `appendix.html` | 附录 A 案例索引 + 附录 B 前言 |
| `all.html` | 24 个案例全文单页版（适合 Ctrl+F 与打印） |
| `404.html` | GitHub Pages 自定义 404 |
| `assets/` | 样式、交互脚本、检索索引（`search-index.js`，按需加载） |

全站搜索支持 `Ctrl / Cmd + K`（`/` 也可以），中文按二元组匹配，结果按内容相关度排序并高亮命中词。

## 本地预览

```powershell
cd Datawhale-FDE
python build_site.py          # 由 Markdown 重新生成站点
python -m http.server 8765    # 打开 http://127.0.0.1:8765
```

直接双击 `index.html` 也能读，但 `file://` 下检索索引会因浏览器安全策略加载失败，建议用上面的本地服务器。

## 部署到 GitHub Pages

```powershell
git init -b main
git add .
git commit -m "FDE 案例 100 阅读站"
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

然后到仓库 **Settings → Pages**：

- Source 选 **Deploy from a branch**
- Branch 选 **`main`**，目录选 **`/ (root)`**
- Save

等 1–2 分钟，访问 `https://<你的用户名>.github.io/<仓库名>/`。

> 站点根目录已放 `.nojekyll`，跳过 Jekyll 处理；所有链接都是相对路径，所以放在子路径（`/仓库名/`）下也不会出错。如果以后要绑自定义域名，在 Pages 设置里填域名即可，不用改代码。

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
