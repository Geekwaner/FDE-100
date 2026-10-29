"""检查代理是否真的在流式下发（SSE）。

用法：
    python tools/proxy_probe.py https://xxx/api/chat "有哪些制造业案例？"

输出：首字节时间、首个 message 事件时间、总耗时、字符数。
首字节早于首个 message 就说明链路在流式透传，而不是攒完再发。
"""

import json
import sys
import time
import urllib.request


def main() -> None:
    url = sys.argv[1]
    query = sys.argv[2] if len(sys.argv) > 2 else "有哪些和制造业相关的案例？"
    payload = json.dumps(
        {"query": query, "conversation_id": "", "user": "probe"}, ensure_ascii=False
    ).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json; charset=utf-8"}
    )

    t0 = time.time()
    first_byte = None
    first_msg = None
    chars = 0
    events = 0
    with urllib.request.urlopen(req, timeout=180) as resp:
        print("HTTP", resp.status, "| Content-Type:", resp.headers.get("content-type"))
        buf = b""
        while True:
            chunk = resp.read(512)
            if not chunk:
                break
            if first_byte is None:
                first_byte = time.time() - t0
            buf += chunk
            while b"\n\n" in buf:
                block, buf = buf.split(b"\n\n", 1)
                for line in block.split(b"\n"):
                    if not line.startswith(b"data:"):
                        continue
                    events += 1
                    data = line[5:].strip()
                    if data == b"[DONE]":
                        continue
                    try:
                        ev = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if ev.get("event") in ("message", "agent_message"):
                        if first_msg is None:
                            first_msg = time.time() - t0
                        chars += len(ev.get("answer", ""))

    total = time.time() - t0
    print(f"首字节 {first_byte:.2f}s" if first_byte else "首字节 无")
    print(f"首段回答 {first_msg:.2f}s" if first_msg else "首段回答 无（可能是一次性 JSON）")
    print(f"事件 {events} 个，累计 {chars} 字，总耗时 {total:.1f}s")


if __name__ == "__main__":
    main()
