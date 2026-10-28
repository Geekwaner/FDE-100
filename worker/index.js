/**
 * Cloudflare Worker：Dify 代理（把 API Key 留在服务端）
 *
 * 部署：
 *   npx wrangler login
 *   npx wrangler secret put DIFY_API_KEY      # 粘贴 app-xxxx
 *   npx wrangler deploy
 *
 * 变量（wrangler.toml 的 [vars] 或 dashboard）：
 *   DIFY_API_BASE  默认 https://api.dify.ai/v1
 *   ALLOW_ORIGIN   允许的站点，逗号分隔，例如 https://geekwaner.github.io
 */

const CORS_MAX_AGE = "86400";

function corsHeaders(request, env) {
  const allow = (env.ALLOW_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const value = allow.includes("*") ? "*" : allow.includes(origin) ? origin : allow[0] || "null";
  return {
    "Access-Control-Allow-Origin": value,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": CORS_MAX_AGE,
    Vary: "Origin",
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/api/health") {
      return json({ ok: true, upstream: env.DIFY_API_BASE || "https://api.dify.ai/v1" }, 200, cors);
    }

    if (url.pathname !== "/api/chat") {
      return json({ error: "未知路径，可用：POST /api/chat、GET /api/health" }, 404, cors);
    }
    if (request.method !== "POST") return json({ error: "请用 POST" }, 405, cors);
    if (!env.DIFY_API_KEY) return json({ error: "服务端未配置 DIFY_API_KEY" }, 500, cors);

    let input;
    try {
      input = await request.json();
    } catch {
      return json({ error: "请求不是合法 JSON" }, 400, cors);
    }
    const query = String(input.query || "").trim();
    if (!query) return json({ error: "query 不能为空" }, 400, cors);

    const base = (env.DIFY_API_BASE || "https://api.dify.ai/v1").replace(/\/$/, "");
    const upstream = await fetch(base + "/chat-messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.DIFY_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: input.inputs && typeof input.inputs === "object" ? input.inputs : {},
        query,
        response_mode: "streaming",
        conversation_id: String(input.conversation_id || ""),
        user: String(input.user || "web-anon"),
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return json({ error: text || "Dify 返回错误" }, upstream.status || 502, cors);
    }

    return new Response(upstream.body, {
      headers: {
        ...cors,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  },
};
