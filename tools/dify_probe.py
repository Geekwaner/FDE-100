"""探测 Dify 后端 API 的连通性与流式响应（不打印密钥）。

用法：python tools/dify_probe.py "你的问题"
"""

import json
import re
import ssl
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://api.dify.ai/v1"


def load_key() -> str:
    text = (ROOT / ".env").read_text(encoding="utf-8")
    m = re.search(r"Dify_key\s*=\s*(\S+)", text)
    if not m:
        raise SystemExit("没有在 .env 里找到 Dify_key")
    return m.group(1)


def main() -> None:
    query = sys.argv[1] if len(sys.argv) > 1 else "有哪些和制造业相关的案例？"
    key = load_key()
    payload = json.dumps(
        {
            "inputs": {},
            "query": query,
            "response_mode": "streaming",
            "conversation_id": "",
            "user": "probe",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        BASE + "/chat-messages",
        data=payload,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    ctx = ssl.create_default_context()
    t0 = time.time()
    first = None
    chars = 0
    with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
        print("HTTP", resp.status, "type", resp.headers.get("content-type"))
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                ev = json.loads(data)
            except json.JSONDecodeError:
                continue
            event = ev.get("event")
            if first is None:
                first = time.time() - t0
                print(f"首事件 {event} 用时 {first:.1f}s")
            if event in ("message", "agent_message"):
                chars += len(ev.get("answer", ""))
            elif event == "message_end":
                print("message_end 用时 %.1fs" % (time.time() - t0))
    print(f"累计字符 {chars}，总耗时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
