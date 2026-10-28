/**
 * 本地 / VPS 用的 Dify 代理（零依赖，Node 18+）。
 *
 * 作用：把 Dify 的 API Key 留在服务端，浏览器只跟本代理说话。
 *
 * 用法：
 *   node server/proxy.mjs                 # 默认 http://127.0.0.1:8787
 *   PORT=9000 node server/proxy.mjs
 *
 * 环境变量：
 *   DIFY_KEY      必填，也可写在项目根目录 .env（Dify_key=app-xxx）
 *   DIFY_API_BASE 默认 https://api.dify.ai/v1
 *   ALLOW_ORIGIN  允许的站点来源，默认 *（本地开发）；上线请填你的站点点位，逗号分隔
 *   PORT          监听端口，默认 8787
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const ROOT = path.resolve(import.meta.dirname, "..");

function readEnvFile() {
  const out = {};
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

const envFile = readEnvFile();
const DIFY_KEY = process.env.DIFY_KEY || envFile.Dify_key || envFile.DIFY_KEY;
const API_BASE = (process.env.DIFY_API_BASE || "https://api.dify.ai/v1").replace(/\/$/, "");
const ALLOW = (process.env.ALLOW_ORIGIN || "*").split(",").map((s) => s.trim());
const PORT = Number(process.env.PORT || 8787);

if (!DIFY_KEY) {
  console.error("缺少 DIFY_KEY：请设置环境变量，或在项目根目录 .env 里写 Dify_key=app-xxx");
  process.exit(1);
}

/* 极简限流：每个 IP 每分钟 30 次，够单机自用 */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { t: now, n: 0 };
  if (now - rec.t > 60_000) {
    rec.t = now;
    rec.n = 0;
  }
  rec.n += 1;
  hits.set(ip, rec);
  return rec.n > 30;
}

function corsHeaders(origin) {
  const allow = ALLOW.includes("*") ? "*" : ALLOW.includes(origin) ? origin : ALLOW[0];
  return {
    "Access-Control-Allow-Origin": allow || "null",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function sendJSON(res, cors, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...cors,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleChat(req, res, cors) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) {
      sendJSON(res, cors, 413, { error: "请求体过大" });
      return;
    }
  }
  let input;
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    sendJSON(res, cors, 400, { error: "请求不是合法 JSON" });
    return;
  }
  const query = String(input.query || "").trim();
  if (!query) {
    sendJSON(res, cors, 400, { error: "query 不能为空" });
    return;
  }

  const payload = {
    inputs: input.inputs && typeof input.inputs === "object" ? input.inputs : {},
    query,
    response_mode: "streaming",
    conversation_id: String(input.conversation_id || ""),
    user: String(input.user || "web-" + (req.socket.remoteAddress || "anon")),
  };

  let upstream;
  try {
    upstream = await fetch(API_BASE + "/chat-messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + DIFY_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    sendJSON(res, cors, 502, { error: "无法连接 Dify：" + err.message });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    sendJSON(res, cors, upstream.status, { error: text || "Dify 返回错误" });
    return;
  }

  res.writeHead(200, {
    ...cors,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // 关掉 nginx 缓冲，否则流会被攒起来
  });
  const stream = Readable.fromWeb(upstream.body);
  stream.pipe(res);
  stream.on("error", () => res.end());
  req.on("close", () => stream.destroy());
}

/* 顺带托管静态站点：本地预览时与线上同源，/api/chat 直接可用 */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ""));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      const notFound = path.join(ROOT, "404.html");
      fs.readFile(notFound, (e2, page) => {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(e2 ? "404" : page);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders(req.headers.origin || "");
  const url = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (url.pathname === "/api/health") {
    sendJSON(res, cors, 200, { ok: true, upstream: API_BASE });
    return;
  }
  if (url.pathname === "/api/chat") {
    if (req.method !== "POST") {
      sendJSON(res, cors, 405, { error: "请用 POST" });
      return;
    }
    const ip = req.socket.remoteAddress || "anon";
    if (limited(ip)) {
      sendJSON(res, cors, 429, { error: "请求过于频繁，请稍后再试" });
      return;
    }
    await handleChat(req, res, cors);
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`站点 + Dify 代理已启动：http://127.0.0.1:${PORT}/`);
  console.log(`  问答接口 = http://127.0.0.1:${PORT}/api/chat`);
  console.log(`  upstream  = ${API_BASE}`);
  console.log(`  allow     = ${ALLOW.join(", ")}`);
});
