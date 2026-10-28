"""把 FDE案例100 纯文字版整理成 RAG 友好格式。

用法：
    python prepare_rag_doc.py                      # 处理完整版（默认）
    python prepare_rag_doc.py <src.md> <dst.md>    # 处理指定文件

做了哪些事（每一条都是为了提升检索命中质量）：
1. 删掉 frontmatter、文档自述、目录列表（低质 chunk，会和正文抢召回席位）
2. 前言「AI开始真正走进企业」移到文末附录，避免开篇通用叙述污染案例检索
3. 每个案例标题下补 **案例编号**，让每个 chunk 自带身份标识
4. 每个 Q 标题注入 [NO.x 短案例名]，chunk 被切开后仍知道自己在哪个案例里
5. 删掉纯图注行（*图1：xxx*）——图片已剥离，图注单独成段只是噪声
6. 删掉从 PDF 带过来的编辑备注（> **原文件说明**）
7. 修正 NO.2 / NO.5 在原始 PDF 中错位的案例标签（模板未更新导致），并显式标注
8. 文末生成「附录A 案例索引」：一行一案例（编号+标题+标签），支撑“有哪些制造业案例”这类全局提问
"""

import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("Datawhale-FDE案例100-纯文字.md")
DST = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("Datawhale-FDE案例100-纯文字-RAG版.md")

# 原始 PDF 中标签错位的案例（排版模板未更新），这里按案例实际内容修正
TAG_FIX = {
    "NO.2": "政务服务 · 公安交管 · 材料审核 · OCR · RPA · 流程自动化",
    "NO.5": "跨境电商 · TikTok电商 · 达人建联 · 履约管理 · Agent工作流",
}

RE_CASE = re.compile(r"^##\s+(NO\.\d+)\s*(.+)$")
RE_Q = re.compile(r"^###\s+(Q\d+)\s*[：:]\s*(.*)$")
RE_FIG = re.compile(r"^\*\s*图\s*\d+\s*[：:]")
RE_NOTE = re.compile(r"^>\s*\*\*原文件说明\*\*")

lines = SRC.read_text(encoding="utf-8").splitlines()

body: list[str] = []          # 案例正文
preface: list[str] = []       # 前言（搬到附录）
index: list[str] = []         # 案例索引行

in_frontmatter = False
frontmatter_done = False
in_toc = False
in_preface = False
case = None                   # (编号, 短名)
expect_intro = False          # 下一个普通段落是文档自述，丢弃

for raw in lines:
    stripped = raw.strip()

    # ---- 1) 跳过 frontmatter ----
    if not frontmatter_done:
        if stripped == "---":
            if not in_frontmatter:
                in_frontmatter = True
            else:
                in_frontmatter = False
                frontmatter_done = True
            continue
        if in_frontmatter:
            continue

    # ---- 2) 跳过目录段 ----
    if stripped == "## 目录":
        in_toc = True
        continue
    if in_toc:
        if stripped.startswith("## "):
            in_toc = False
        elif stripped.startswith("# "):
            in_toc = False
        else:
            continue

    # ---- 3) 前言整段搬到附录 ----
    if stripped == "## AI开始真正走进企业":
        in_preface = True
        continue

    # ---- 4) 案例标题 ----
    m = RE_CASE.match(stripped)
    if m:
        in_preface = False
        no, full = m.group(1), m.group(2).strip()
        short = full.split("：")[0].split(":")[0].strip()
        case = (no, short)
        body.append(f"## {no} {full}")
        body.append("")
        body.append(f"**案例编号**：{no}")
        body.append("")
        index.append(f"- **{no}** {full}")
        continue

    if in_preface:
        if stripped.startswith("# "):
            in_preface = False
        else:
            preface.append(raw)
            continue

    # ---- 5) 文档自述（H1 之后那段“本文档由 PDF 转换生成”）----
    if stripped.startswith("# Datawhale FDE案例100"):
        expect_intro = True
        continue
    if expect_intro:
        if stripped == "":
            continue
        expect_intro = False  # 只丢第一个段落
        continue

    # ---- 6) 噪声行 ----
    if RE_FIG.match(stripped) or RE_NOTE.match(stripped):
        continue

    # ---- 7) 标签修正 ----
    if stripped.startswith("**案例标签**") and case and case[0] in TAG_FIX:
        body.append(f"**案例标签**：{TAG_FIX[case[0]]}（RAG版修正）")
        body.append("")
        continue

    # ---- 8) Q 标题注入案例标识 ----
    mq = RE_Q.match(stripped)
    if mq and case:
        body.append(f"### {mq.group(1)} [{case[0]} {case[1]}]：{mq.group(2)}")
        continue

    body.append(raw)

# ---- 组装输出 ----
head = [
    "# Datawhale FDE案例100（RAG 检索版）",
    "",
    "本文件由 `Datawhale-FDE案例100-纯文字.md`（源自 246 页 PDF，共 24 个案例）整理而成，"
    "专为检索增强生成（RAG）与全文检索优化：已剔除目录、图注、编辑备注等噪声，"
    "并在每个案例与问答标题中注入案例身份信息，使任意分块都能自证出处。",
    "",
    "阅读约定：`## NO.x` 为一个完整案例，其下固定 6 个问答（Q1 场景与问题 / Q2 过去做法 / "
    "Q3 方案与步骤 / Q4 实际效果 / Q5 挑战与解决 / Q6 经验建议）。"
    "结构化字段含义：案例编号、案例标签（行业 · 场景 · 技术关键词）、讲述人、案例简介、适用人群。",
    "",
]

appendix = ["", "---", "", "# 附录A：案例索引", "", "全部 24 个案例一览（编号 · 标题），用于定位与全局概览。", ""]
appendix += index
appendix += ["", "---", "", "# 附录B：前言（FDE 与 AI 落地理念）", ""]
appendix += preface

out = "\n".join(head + body).rstrip() + "\n" + "\n".join(appendix).rstrip() + "\n"
out = re.sub(r"\n{3,}", "\n\n", out)
DST.write_text(out, encoding="utf-8")

print(f"done -> {DST}")
print(f"  案例数: {len(index)}  行数: {len(out.splitlines())}  字符数: {len(out)}")
