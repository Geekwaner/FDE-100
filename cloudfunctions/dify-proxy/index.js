/**
 * 腾讯云 CloudBase 云函数：Dify 代理
 *
 * 环境变量（在云函数配置里设置）：
 *   DIFY_API_KEY   app-xxxx（必填，不要写进代码）
 *   DIFY_API_BASE  默认 https://api.dify.ai/v1
 *   ALLOW_ORIGIN   允许的站点，逗号分隔，如 https://geekwaner.github.io
 *
 * 说明：CloudBase 的 HTTP 访问服务会把响应整体返回，没有 SSE 流式；
 * 这里用 Dify 的 blocking 模式（实测约 15s），前端 chat.js 会自动识别 JSON 并整段渲染。
 */

const DIFY_BASE = (process.env.DIFY_API_BASE || 'https://api.dify.ai/v1').replace(/\/$/, '');

function corsHeaders(origin) {
  const allow = (process.env.ALLOW_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const value = allow.includes('*') ? '*' : allow.includes(origin) ? origin : allow[0] || 'null';
  return {
    'Access-Control-Allow-Origin': value,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function reply(statusCode, body, cors) {
  return {
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function readBody(event) {
  if (!event || !event.body) return {};
  let raw = event.body;
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

exports.main = async (event = {}) => {
  const method = String(event.httpMethod || event.method || 'GET').toUpperCase();
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || '';
  const cors = corsHeaders(origin);
  const path = String(event.path || event.pathParameters || '/');

  if (method === 'OPTIONS') return reply(204, '', cors);

  if (path.indexOf('/health') !== -1) {
    return reply(200, { ok: true, upstream: DIFY_BASE }, cors);
  }

  if (method !== 'POST') return reply(405, { error: '请用 POST' }, cors);

  const key = process.env.DIFY_API_KEY;
  if (!key) return reply(500, { error: '服务端未配置 DIFY_API_KEY' }, cors);

  const input = readBody(event);
  if (input === null) return reply(400, { error: '请求不是合法 JSON' }, cors);

  const query = String(input.query || '').trim();
  if (!query) return reply(400, { error: 'query 不能为空' }, cors);

  try {
    const res = await fetch(DIFY_BASE + '/chat-messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: input.inputs && typeof input.inputs === 'object' ? input.inputs : {},
        query,
        response_mode: 'blocking',
        conversation_id: String(input.conversation_id || ''),
        user: String(input.user || 'web'),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return reply(res.status, { error: text || 'Dify 返回错误' }, cors);
    }
    const data = await res.json();
    return reply(200, data, cors);
  } catch (err) {
    return reply(502, { error: '无法连接 Dify：' + err.message }, cors);
  }
};
