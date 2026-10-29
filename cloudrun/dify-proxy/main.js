/**
 * 云托管（容器型）版 Dify 代理：支持 SSE 真流式
 *
 * 为什么单独一份：云函数（SCF）的 HTTP 触发会把响应攒完再返回，拿不到 SSE；
 * 容器里自己 res.write() 就是逐块下发，前端能逐字渲染。
 *
 * 环境变量：DIFY_API_KEY / DIFY_API_BASE / ALLOW_ORIGIN / PORT
 */

import http from "node:http";
import { Readable } from "node:stream";

const KEY = process.env.DIFY_API_KEY || "";
const BASE = (process.env.DIFY_API_BASE || "https://api.dify.ai/v1").replace(/\/$/, "");
const ALLOW = (process.env.ALLOW_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT || 8080);

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
    return json(res, head, 200, { ok: true, upstream: BASE, key: Boolean(KEY), port: PORT });
  }
  if (url.pathname === "/api/chat") {
    if (req.method !== "POST") return json(res, head, 405, { error: "请用 POST" });
    if (!KEY) return json(res, head, 500, { error: "服务端未配置 DIFY_API_KEY" });
    return handleChat(req, res, head);
  }
  return json(res, head, 404, { error: "未知路径，可用：POST /api/chat、GET /health" });
});

server.listen(PORT, () => {
  console.log("dify-proxy listening on " + PORT + " → " + BASE);
});
