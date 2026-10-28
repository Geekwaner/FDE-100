"""把《Datawhale FDE案例100》Markdown 构建成静态站点（GitHub Pages 可直接托管）。

用法：
    python build_site.py

输入：Datawhale-FDE案例100-纯文字-RAG版.md
输出：
    index.html            首页（案例卡片 + 行业筛选 + 全站搜索）
    cases/no-XX.html      24 个案例详情页（Q1–Q6）
    appendix.html         附录（案例索引 + 前言）
    assets/search-index.js  客户端检索索引
纯标准库，无需安装依赖，产物直接提交即可用分支方式部署 Pages。
"""

import html
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "Datawhale-FDE案例100-纯文字-RAG版.md"
ASSETS = ROOT / "assets"
CASES_DIR = ROOT / "cases"

SITE_NAME = "FDE 案例 100"
SITE_SUB = "Datawhale FDE 案例集 · 24 个真实企业 AI 落地现场"

RE_CASE = re.compile(r"^##\s+(NO\.\d+)\s*(.+)$")
RE_Q = re.compile(r"^###\s+(Q\d+)\s*\[(NO\.\d+)\s+([^\]]+)\]\s*[：:]\s*(.+)$")
RE_H2 = re.compile(r"^##\s+(.+)$")
RE_H1 = re.compile(r"^#\s+(.+)$")

# 24 个案例固定同一套问题，给侧栏一个短标签，比只写 Q1 更好读
Q_SHORT = {
    "Q1": "场景与问题",
    "Q2": "过去做法",
    "Q3": "方案与步骤",
    "Q4": "实际效果",
    "Q5": "挑战与解决",
    "Q6": "经验建议",
}


# ---------------------------------------------------------------- 解析
def parse(md: str):
    cases: list[dict] = []
    preface: list[dict] = []  # 附录B 的段落块
    cur = None
    cur_q = None
    sect = None  # summary / audience / preface
    in_appendix_b = False

    for line in md.splitlines():
        s = line.strip()

        m = RE_CASE.match(s)
        if m and not in_appendix_b:
            cur_q = None
            cur = {
                "no": m.group(1),
                "title": m.group(2).strip(),
                "alt": "",
                "tags": [],
                "speaker": "",
                "quote": "",
                "summary": [],
                "audience": [],
                "qas": [],
            }
            cases.append(cur)
            sect = None
            continue

        if s.startswith("# 附录B"):
            in_appendix_b = True
            cur = None
            continue

        if in_appendix_b:
            if s.startswith("# "):
                in_appendix_b = False
                continue
            if s:
                preface.append({"type": "p", "text": s})
            continue

        if cur is None:
            continue

        mq = RE_Q.match(s)
        if mq:
            cur_q = {
                "id": mq.group(1).lower(),
                "label": mq.group(1),
                "short": Q_SHORT.get(mq.group(1), ""),
                "q": mq.group(4).strip(),
                "blocks": [],
            }
            cur["qas"].append(cur_q)
            sect = None
            continue

        if s.startswith("### ") or s.startswith("## "):
            continue

        if s.startswith("**案例编号**"):
            continue
        if s.startswith("**封面标题**"):
            cur["alt"] = s.split("：", 1)[-1].strip()
            continue
        if s.startswith("**案例标签**"):
            raw = s.split("：", 1)[-1].replace("（RAG版修正）", "").strip()
            cur["tags"] = [t.strip() for t in raw.split("·") if t.strip()]
            continue
        if s.startswith("**讲述人**"):
            cur["speaker"] = s.split("：", 1)[-1].strip()
            continue
        if s == "**案例简介**":
            sect = "summary"
            continue
        if s == "**适用人群**":
            sect = "audience"
            continue
        if not s:
            continue

        block = cur_q["blocks"] if cur_q else None
        if s.startswith("> "):
            if block is not None:
                block.append({"type": "p", "text": s[2:].strip()})
            elif not cur["quote"]:
                cur["quote"] = s[2:].strip()
            continue
        if s.startswith("- "):
            target = cur["audience"] if sect == "audience" else None
            if target is not None:
                target.append(s[2:].strip())
            elif block is not None:
                block.append({"type": "li", "text": s[2:].strip()})
            continue
        if s == "---":
            continue

        if block is not None:
            block.append({"type": "p", "text": s})
        elif sect == "summary":
            cur["summary"].append(s)
        elif sect == "audience" and not s.startswith("- "):
            cur["audience"].append(s)

    return cases, preface


# ---------------------------------------------------------------- 渲染
def inline(text: str) -> str:
    t = html.escape(text)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"`(.+?)`", r"<code>\1</code>", t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', t)
    return t


def render_blocks(blocks: list[dict]) -> str:
    out, buf = [], []

    def flush():
        if buf:
            out.append("<p>" + "<br>".join(buf) + "</p>")
            buf.clear()

    for b in blocks:
        if b["type"] == "li":
            flush()
            out.append(f"<li>{inline(b['text'])}</li>")
        else:
            buf.append(inline(b["text"]))
    flush()
    res = "\n".join(out)
    res = re.sub(r"(?:<li>.*?</li>\n?)+", lambda m: "<ul>" + m.group(0) + "</ul>", res, flags=re.S)
    return res


def slug(no: str) -> str:
    return "no-%02d" % int(no.split(".")[1])


def plain(text: str) -> str:
    return re.sub(r"\*\*|`", "", text).strip()


def excerpt(case: dict, n: int = 78) -> str:
    t = "".join(case["summary"])
    t = re.sub(r"\s+", "", t)
    return t if len(t) <= n else t[:n] + "…"


# ---------------------------------------------------------------- 页面骨架
def shell(title: str, root: str, body: str, active: str = "", desc: str = SITE_SUB) -> str:
    nav = [
        ("index.html", "案例索引", "index"),
        ("appendix.html", "前言", "appendix"),
        ("all.html", "全文", "all"),
    ]
    links = "".join(
        f'<a class="nav-link{" is-active" if key == active else ""}" href="{root}{href}">{label}</a>'
        for href, label, key in nav
    )
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(desc)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23b3402b'/%3E%3Ctext x='16' y='22' font-family='Georgia,serif' font-size='15' fill='%23faf7f0' text-anchor='middle'%3EF%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="{root}assets/style.css">
</head>
<body data-root="{root}">
<div class="progress" id="progress"></div>
<header class="site-header">
  <a class="brand" href="{root}index.html">
    <span class="brand-mark">FDE</span>
    <span class="brand-text">案例 100</span>
  </a>
  <nav class="site-nav">{links}</nav>
  <button class="search-btn" id="search-open" type="button" aria-label="搜索全文">
    <span class="search-btn-icon">⌕</span><span class="search-btn-text">搜索</span><kbd>Ctrl K</kbd>
  </button>
</header>
{body}
<footer class="site-footer">
  <p>内容来源：Datawhale《FDE案例100》（2026 年 9 月），本站为非官方阅读版，仅供学习交流。</p>
  <p class="footer-meta">由 <code>build_site.py</code> 从 Markdown 生成 · 托管于 GitHub Pages</p>
</footer>
<div class="search-overlay" id="search-overlay" hidden>
  <div class="search-panel" role="dialog" aria-modal="true" aria-label="全文搜索">
    <div class="search-field">
      <span class="search-btn-icon">⌕</span>
      <input id="search-input" type="search" placeholder="搜索案例、行业、痛点、方案……" autocomplete="off">
      <kbd>Esc</kbd>
    </div>
    <div class="search-hint" id="search-hint">输入关键词，例如「OCR」「财务对账」「知识库」</div>
    <ul class="search-results" id="search-results"></ul>
  </div>
</div>
<script src="{root}assets/app.js"></script>
</body>
</html>
"""


# ---------------------------------------------------------------- 首页
def build_index(cases: list[dict]) -> str:
    industries: dict[str, int] = {}
    for c in cases:
        ind = c["tags"][0] if c["tags"] else "其他"
        industries[ind] = industries.get(ind, 0) + 1

    chips = ['<button class="chip is-on" data-ind="*" type="button">全部<span>%d</span></button>' % len(cases)]
    for ind, n in sorted(industries.items(), key=lambda kv: (-kv[1], kv[0])):
        chips.append(
            f'<button class="chip" data-ind="{html.escape(ind)}" type="button">{html.escape(ind)}<span>{n}</span></button>'
        )

    cards = []
    for c in cases:
        tags = "".join(f"<span>{html.escape(t)}</span>" for t in c["tags"][1:4])
        cards.append(
            f"""<a class="card" href="cases/{slug(c['no'])}.html" data-ind="{html.escape(c['tags'][0] if c['tags'] else '其他')}">
  <div class="card-no">{c['no']}</div>
  <h2 class="card-title">{html.escape(c['title'])}</h2>
  <div class="card-tags">{tags}</div>
  <p class="card-excerpt">{html.escape(excerpt(c))}</p>
  <div class="card-foot"><span>{html.escape(c['speaker'].split('｜')[0].strip())}</span><span class="card-arrow">→</span></div>
</a>"""
        )

    body = f"""
<main class="wrap">
  <section class="hero">
    <p class="eyebrow">Datawhale · 2026 年 9 月</p>
    <h1 class="hero-title">FDE 案例 100</h1>
    <p class="hero-lede">24 个来自真实企业现场的 AI 落地案例。每个案例都保留同一条线索：<em>问题是怎么被发现的</em>、过去怎么做、AI 怎么接进去、效果如何、又卡在哪里。</p>
    <dl class="stats">
      <div><dt>案例</dt><dd>{len(cases)}</dd></div>
      <div><dt>问答</dt><dd>{sum(len(c['qas']) for c in cases)}</dd></div>
      <div><dt>行业</dt><dd>{len(industries)}</dd></div>
    </dl>
  </section>

  <section class="filterbar">
    <div class="chips" id="chips">{''.join(chips)}</div>
  </section>

  <section class="cards" id="cards">
    {''.join(cards)}
  </section>
  <p class="empty" id="empty" hidden>该行业下暂无案例。</p>
</main>
"""
    return shell(f"{SITE_NAME} · Datawhale", "", body, active="index")


# ---------------------------------------------------------------- 案例页
def build_case(case: dict, prev: dict | None, nxt: dict | None, cases: list[dict]) -> str:
    no, title = case["no"], case["title"]
    short = title.split("：")[0].split(":")[0].strip()
    industry = case["tags"][0] if case["tags"] else ""

    toc = "".join(
        f'<a href="#{q["id"]}" data-target="{q["id"]}">{q["label"]}<em>{q["short"]}</em></a>'
        for q in case["qas"]
    )

    qa_html = []
    for q in case["qas"]:
        qa_html.append(
            f"""<section class="qa" id="{q['id']}">
  <h2 class="q-title"><span class="q-badge">{q['label']}</span><span>{html.escape(q['q'])}</span><a class="q-anchor" href="#{q['id']}" aria-label="复制本段链接">#</a></h2>
  {render_blocks(q['blocks'])}
</section>"""
        )

    tags = "".join(f'<span class="tag">{html.escape(t)}</span>' for t in case["tags"])
    audience = "".join(f"<li>{inline(a)}</li>" for a in case["audience"])
    quote = f'<blockquote class="case-quote">{inline(case["quote"])}</blockquote>' if case["quote"] else ""
    alt = f'<p class="case-alt">{html.escape(case["alt"])}</p>' if case["alt"] else ""

    pager = ['<nav class="pager">']
    if prev:
        pager.append(
            f'<a class="pager-link prev" href="{slug(prev["no"])}.html"><span>上一案例</span><strong>{prev["no"]} {html.escape(prev["title"].split("：")[0])}</strong></a>'
        )
    if nxt:
        pager.append(
            f'<a class="pager-link next" href="{slug(nxt["no"])}.html"><span>下一案例</span><strong>{nxt["no"]} {html.escape(nxt["title"].split("：")[0])}</strong></a>'
        )
    pager.append("</nav>")

    select = "".join(
        f'<option value="{slug(c["no"])}.html"{" selected" if c["no"] == no else ""}>{c["no"]} {html.escape(c["title"].split("：")[0])}</option>'
        for c in cases
    )

    body = f"""
<main class="wrap">
  <div class="case-layout">
    <article class="case">
      <p class="case-kicker">{no} · {html.escape(industry)}</p>
      <h1 class="case-title">{html.escape(title)}</h1>
      {alt}
      <p class="case-speaker">讲述人：{html.escape(case['speaker'])}</p>
      {quote}
      <div class="case-tags">{tags}</div>

      <section class="case-intro">
        <h2 class="section-label">案例简介</h2>
        <p class="case-lead">{"".join(inline(p) for p in case['summary'])}</p>
        <h2 class="section-label">适用人群</h2>
        <ul class="audience">{audience}</ul>
      </section>

      <div class="qa-list">
        {''.join(qa_html)}
      </div>

      {''.join(pager)}
      <p class="case-back"><a href="../index.html">← 返回案例索引</a></p>
    </article>

    <aside class="case-aside">
      <div class="aside-inner">
        <p class="aside-label">本案例问答</p>
        <nav class="aside-toc" id="toc">{toc}</nav>
        <a class="aside-all" href="../index.html">案例索引</a>
      </div>
    </aside>
  </div>
</main>
<div class="mobile-jump">
  <select id="case-jump" aria-label="跳到其他案例">{select}</select>
</div>
"""
    return shell(f"{no} {short} · {SITE_NAME}", "../", body, active="index", desc=f"{no} {title}")


# ---------------------------------------------------------------- 附录
def build_appendix(cases: list[dict], preface: list[dict]) -> str:
    rows = "".join(
        f'<li><a href="cases/{slug(c["no"])}.html"><span class="idx-no">{c["no"]}</span><span>{html.escape(c["title"])}</span></a></li>'
        for c in cases
    )
    pre = render_blocks(preface)
    body = f"""
<main class="wrap">
  <article class="case case--doc">
    <p class="case-kicker">附录</p>
    <h1 class="case-title">案例索引与前言</h1>
    <section class="qa">
      <h2 class="q-title"><span class="q-badge">A</span><span>案例索引</span></h2>
      <ol class="idx-list">{rows}</ol>
    </section>
    <section class="qa">
      <h2 class="q-title"><span class="q-badge">B</span><span>前言：AI 开始真正走进企业</span></h2>
      {pre}
    </section>
    <p class="case-back"><a href="index.html">← 返回案例索引</a></p>
  </article>
</main>
"""
    return shell(f"附录 · {SITE_NAME}", "", body, active="appendix")


# ---------------------------------------------------------------- 全文页
def build_all(cases: list[dict]) -> str:
    parts = []
    for c in cases:
        qas = "".join(
            f'<h3 class="all-q" id="{slug(c["no"])}-{q["id"]}">{q["label"]}　{html.escape(q["q"])}</h3>'
            + render_blocks(q["blocks"])
            for q in c["qas"]
        )
        parts.append(
            f"""<section class="all-case" id="{slug(c['no'])}">
  <h2><a href="cases/{slug(c['no'])}.html">{c['no']}　{html.escape(c['title'])}</a></h2>
  <p class="all-meta">{html.escape(' · '.join(c['tags']))}　｜　讲述人：{html.escape(c['speaker'])}</p>
  <p class="all-lead">{''.join(inline(p) for p in c['summary'])}</p>
  {qas}
</section>"""
        )
    body = f"""
<main class="wrap wrap--narrow">
  <article class="case case--doc">
    <p class="case-kicker">全文</p>
    <h1 class="case-title">24 个案例全文</h1>
    <p class="case-speaker">单页版，适合 Ctrl+F 或打印。分案例阅读见<a href="index.html">案例索引</a>。</p>
    {''.join(parts)}
  </article>
</main>
"""
    return shell(f"全文 · {SITE_NAME}", "", body, active="all")


# ---------------------------------------------------------------- 404
def build_404() -> str:
    body = """
<main class="wrap">
  <article class="case case--doc">
    <p class="case-kicker">404</p>
    <h1 class="case-title">这个页面不存在</h1>
    <p class="case-lead">链接可能已经变化。回到<a href="index.html">案例索引</a>，或用右上角搜索找你要的案例。</p>
  </article>
</main>
"""
    return shell(f"页面不存在 · {SITE_NAME}", "", body)


# ---------------------------------------------------------------- 检索索引
def build_search_index(cases: list[dict]) -> str:
    docs = []
    for c in cases:
        meta = f"{' '.join(c['tags'])} {c['speaker']}"
        docs.append(
            {
                "t": f"{c['no']} {c['title']}",
                "k": c["tags"][0] if c["tags"] else "",
                "u": f"cases/{slug(c['no'])}.html",
                "x": plain(meta + " " + "".join(c["summary"]) + " " + " ".join(c["audience"])),
            }
        )
        for q in c["qas"]:
            body_text = plain("".join(b["text"] for b in q["blocks"]))
            docs.append(
                {
                    "t": f"{c['no']} {c['title']} · {q['label']}",
                    "k": c["tags"][0] if c["tags"] else "",
                    "u": f"cases/{slug(c['no'])}.html#{q['id']}",
                    "x": plain(f"{q['q']} {body_text}"),
                }
            )
    payload = json.dumps(docs, ensure_ascii=False, separators=(",", ":"))
    return f"window.SEARCH_INDEX={payload};\n"


def main() -> None:
    md = SRC.read_text(encoding="utf-8")
    cases, preface = parse(md)
    if len(cases) != 24:
        raise SystemExit(f"解析到 {len(cases)} 个案例，预期 24 个，请检查源文档结构")

    CASES_DIR.mkdir(exist_ok=True)
    for i, c in enumerate(cases):
        prev = cases[i - 1] if i > 0 else None
        nxt = cases[i + 1] if i < len(cases) - 1 else None
        (CASES_DIR / f"{slug(c['no'])}.html").write_text(
            build_case(c, prev, nxt, cases), encoding="utf-8"
        )

    (ROOT / "index.html").write_text(build_index(cases), encoding="utf-8")
    (ROOT / "appendix.html").write_text(build_appendix(cases, preface), encoding="utf-8")
    (ROOT / "all.html").write_text(build_all(cases), encoding="utf-8")
    (ROOT / "404.html").write_text(build_404(), encoding="utf-8")
    (ASSETS / "search-index.js").write_text(build_search_index(cases), encoding="utf-8")
    (ROOT / ".nojekyll").write_text("", encoding="utf-8")

    n_q = sum(len(c["qas"]) for c in cases)
    print(f"构建完成：{len(cases)} 个案例 / {n_q} 个问答")
    print(f"  首页 index.html · 详情页 cases/ ×{len(cases)} · 附录 appendix.html · 全文 all.html")
    print(f"  检索索引 assets/search-index.js（{(ASSETS / 'search-index.js').stat().st_size / 1024:.0f} KB）")


if __name__ == "__main__":
    main()
