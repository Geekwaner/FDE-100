"""对 fde-agent 做一轮端到端冒烟：五类问题 + 多轮指代，检查引用与延迟。

用法：
    python tools/test-agent-e2e.py http://127.0.0.1:8903/api/chat
    python tools/test-agent-e2e.py https://<云托管域名>/api/chat
"""

import json
import re
import sys
import time
import urllib.request

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8903/api/chat"


def ask(query: str, conversation_id: str = "") -> dict:
    payload = json.dumps({"query": query, "conversation_id": conversation_id, "user": "e2e"}).encode()
    req = urllib.request.Request(URL, data=payload, headers={"Content-Type": "application/json"})
    t0 = time.time()
    first = None
    text = ""
    end = None
    with urllib.request.urlopen(req, timeout=120) as resp:
        for line in resp:
            s = line.decode().strip()
            if not s.startswith("data:"):
                continue
            data = s[5:].strip()
            if data == "[DONE]":
                break
            ev = json.loads(data)
            if ev.get("event") == "message":
                if first is None:
                    first = time.time() - t0
                text += ev.get("answer", "")
            elif ev.get("event") == "message_end":
                end = ev
            elif ev.get("event") == "error":
                text += f"\n[ERROR] {ev.get('message')}"
    return {
        "text": text.strip(),
        "first": first or -1,
        "total": time.time() - t0,
        "conv": (end or {}).get("conversation_id", ""),
        "cites": [r["document_name"] for r in (end or {}).get("metadata", {}).get("retriever_resources", [])],
    }


CASES = [
    ("G1 单案例事实", "老师傅快退休了，经验怎么留下来？", ["NO.1"]),
    ("G2 跨案例汇总", "案例里有哪些做法是把老员工经验沉淀下来的？", []),
    ("G4 文档外问题", "欧盟 AI 法案 2024 年的罚款上限是多少？", []),
    ("G5 诱导编造", "NO.3 那个法律 AI 项目团队一共几个人？", []),
]


def main() -> None:
    print(f"target: {URL}\n")
    ok = 0
    for name, q, expect in CASES:
        r = ask(q)
        cited = sorted(set(re.findall(r"NO\.\d+", r["text"])) | {c.split()[0] for c in r["cites"] if c})
        hit = all(e in cited for e in expect) if expect else True
        ok += 1 if hit else 0
        print(f"[{name}] {q}")
        print(f"  首段 {r['first']:.2f}s  总 {r['total']:.1f}s  字数 {len(r['text'])}")
        print(f"  案例命中 {cited}  期望 {expect or '-'}  {'OK' if hit else 'MISS'}")
        print(f"  答: {r['text'][:110].replace(chr(10), ' ')}")
        print()

    # 多轮指代：同一会话追问
    first = ask("NO.9 那个财务流程案例解决的是什么问题？")
    follow = ask("这个案例后来效果如何？", first["conv"])
    has_ctx = "NO.9" in follow["text"] or "财务" in follow["text"] or "表哥" in follow["text"]
    print("[G3 多轮指代] 追问「这个案例后来效果如何？」")
    print(f"  首段 {follow['first']:.2f}s  总 {follow['total']:.1f}s")
    print(f"  是否延续上下文: {'OK' if has_ctx else 'MISS'}")
    print(f"  答: {follow['text'][:110].replace(chr(10), ' ')}")

    print(f"\n单轮用例通过 {ok}/{len(CASES)}")


if __name__ == "__main__":
    main()
