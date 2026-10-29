/**
 * 云托管（容器型）版 Dify 代理：支持 SSE 真流式
 *
 * 为什么单独一份：云函数（SCF）的 HTTP 触发会把响应攒完再返回，拿不到 SSE；
 * 容器里自己 res.write() 就是逐块下发，前端能逐字渲染。
 *
 * 环境变量：DIFY_API_KEY / DIFY_API_BASE / ALLOW_ORIGIN / PORT
 * 限流：RATE_LIMIT_PER_MIN（每 IP 每分钟，默认 20）/ RATE_LIMIT_PER_DAY（每 IP 每天，默认 100）
 *       GLOBAL_DAILY_CAP（全站每天总次数，默认 500）。任一设为 0 即关闭该项。
 */

import http from "node:http";
import { Readable } from "node:stream";

const KEY = process.env.DIFY_API_KEY || "";
const BASE = (process.env.DIFY_API_BASE || "https://api.dify.ai/v1").replace(/\/$/, "");
const ALLOW = (process.env.ALLOW_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT || 8080);

const LIMIT_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 20);
const LIMIT_DAY = Number(process.env.RATE_LIMIT_PER_DAY ?? 100);
const GLOBAL_CAP = Number(process.env.GLOBAL_DAILY_CAP ?? 500);

/* ------------------------------------------------------------------ 限流
 * 单实例内存计数：冷启动/扩容会重置，属于"挡滥用"而不是"精确配额"。
 * 需要精确配额应换成 Redis 之类的共享存储。
 */
const buckets = new Map(); // ip -> { minStart, minCount, dayKey, dayCount }
let globalDay = { key: dayKey(), count: 0 };

function today() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); // 按 UTC+8 的自然日
}
function dayKey() {
  return today();
}
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function take(ip) {
  const now = Date.now();
  const key = today();
  if (globalDay.key !== key) globalDay = { key, count: 0 };

  let b = buckets.get(ip);
  if (!b) {
    b = { minStart: now, minCount: 0, dayKey: key, dayCount: 0 };
    buckets.set(ip, b);
  }
  if (b.dayKey !== key) {
    b.dayKey = key;
    b.dayCount = 0;
  }
  if (now - b.minStart >= 60_000) {
    b.minStart = now;
    b.minCount = 0;
  }

  if (LIMIT_MIN > 0 && b.minCount >= LIMIT_MIN) {
    const wait = Math.max(1, Math.ceil((60_000 - (now - b.minStart)) / 1000));
    return { ok: false, retry: wait, msg: `提问有点频繁，请 ${wait} 秒后再试。` };
  }
  if (LIMIT_DAY > 0 && b.dayCount >= LIMIT_DAY) {
    return { ok: false, retry: 3600, msg: "今天的提问次数已用完，明天再来吧。" };
  }
  if (GLOBAL_CAP > 0 && globalDay.count >= GLOBAL_CAP) {
    return { ok: false, retry: 3600, msg: "本站今日提问总量已达上限，请明天再试。" };
  }

  b.minCount += 1;
  b.dayCount += 1;
  globalDay.count += 1;

  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.dayKey !== key) buckets.delete(k);
    }
  }
  return { ok: true };
}

function cors(origin) {
  const value = ALLOW.includes("*") ? "*" : ALLOW.includes(origin) ? origin : ALLOW[0] || "null";
  return {
    "Access-Control-Allow-Origin": value,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(res, head, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...head,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleChat(req, res, head) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) return json(res, head, 413, { error: "请求体过大" });
  }

  let input;
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    return json(res, head, 400, { error: "请求不是合法 JSON" });
  }
  const query = String(input.query || "").trim();
  if (!query) return json(res, head, 400, { error: "query 不能为空" });

  let upstream;
  try {
    upstream = await fetch(BASE + "/chat-messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: input.inputs && typeof input.inputs === "object" ? input.inputs : {},
        query,
        response_mode: "streaming",
        conversation_id: String(input.conversation_id || ""),
        user: String(input.user || "web"),
      }),
    });
  } catch (err) {
    return json(res, head, 502, { error: "无法连接 Dify：" + err.message });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return json(res, head, upstream.status, { error: text || "Dify 返回错误" });
  }

  res.writeHead(200, {
    ...head,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const stream = Readable.fromWeb(upstream.body);
  stream.pipe(res);
  stream.on("error", () => res.end());
  req.on("close", () => stream.destroy());
}

const server = http.createServer(async (req, res) => {
  const head = cors(req.headers.origin || "");
  const url = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, head);
    return res.end();
  }
  if (url.pathname === "/health" || url.pathname === "/api/health") {
    return json(res, head, 200, {
      ok: true,
      upstream: BASE,
      key: Boolean(KEY),
      port: PORT,
      limits: {
        perMin: LIMIT_MIN,
        perDay: LIMIT_DAY,
        globalDaily: GLOBAL_CAP,
        globalUsedToday: globalDay.count,
        trackedIps: buckets.size,
      },
    });
  }
  if (url.pathname === "/api/chat") {
    if (req.method !== "POST") return json(res, head, 405, { error: "请用 POST" });
    if (!KEY) return json(res, head, 500, { error: "服务端未配置 DIFY_API_KEY" });

    const gate = take(clientIp(req));
    if (!gate.ok) {
      res.setHeader("Retry-After", String(gate.retry));
      return json(res, head, 429, { error: gate.msg, retryAfter: gate.retry });
    }
    return handleChat(req, res, head);
  }
  return json(res, head, 404, { error: "未知路径，可用：POST /api/chat、GET /health" });
});

server.listen(PORT, () => {
  console.log("dify-proxy listening on " + PORT + " → " + BASE);
});
