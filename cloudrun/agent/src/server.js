/**
 * fde-agent：Mastra Agent + 向量检索的问答服务
 *
 * 对外协议刻意做成「Dify 兼容」：前端 assets/chat.js 不需要改动。
 *   POST /api/chat   { query, conversation_id?, user? } → text/event-stream
 *   GET  /health     索引、模型、限流、内存用量
 */

import express from 'express';
import { randomUUID } from 'node:crypto';
import { config, assertConfig } from './config.js';
import { loadIndex, indexInfo, retrieve, caseBrief } from './retriever.js';
import { stream, openStream } from './sse.js';
import { take, clientIp, limitStats } from './limit.js';
import { getHistory, getRecentCases, appendTurn, newConversationId, memoryStats } from './memory.js';
import { buildMessages, streamAnswer, isAnaphora } from './agent.js';

const missing = assertConfig();
if (missing.length) {
  console.error('缺少必要配置：' + missing.join(', '));
  process.exit(1);
}

const startedAt = Date.now();
const boot = loadIndex();
console.log(`[fde-agent] 索引就绪：${boot.chunks} 块 × ${boot.dim} 维（${boot.model}）`);
console.log(`[fde-agent] 对话模型：${config.llm.model}`);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // CloudBase 网关会带 x-forwarded-for
app.use(express.json({ limit: '64kb' }));

/* ---------------------------------------------------------------- CORS */
app.use((req, res, next) => {
  const allow = config.http.allowOrigin;
  const origin = req.headers.origin || '';
  const value = allow.includes('*') ? '*' : allow.includes(origin) ? origin : allow[0] || 'null';
  res.setHeader('Access-Control-Allow-Origin', value);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* ---------------------------------------------------------------- 健康检查 */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'fde-agent',
    framework: 'mastra',
    model: config.llm.model,
    embedding: config.embedding.model,
    index: indexInfo(),
    retrieval: { topK: config.retrieval.topK, keywordBoost: config.retrieval.keywordBoost },
    limits: limitStats(),
    memory: memoryStats(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  });
});

/* ---------------------------------------------------------------- 问答 */
app.post('/api/chat', async (req, res) => {
  const rid = randomUUID().slice(0, 8);
  const t0 = Date.now();

  const gate = take(clientIp(req));
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retry));
    return res.status(429).json({ error: gate.msg, retryAfter: gate.retry });
  }

  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query 不能为空' });
  if (query.length > 800) return res.status(400).json({ error: '问题太长了，请精简到 800 字以内' });

  const conversationId = String(req.body?.conversation_id || '') || newConversationId();
  let aborted = false;
  // 注意：POST 的 req 在 body 读完时就会触发 close，不能用来判断客户端断开。
  // 用 res 的 close + writableEnded 区分「正常结束」与「客户端中途断开」。
  res.on('close', () => {
    if (!res.writableEnded) aborted = true;
  });

  openStream(res);
  stream.started(res);

  const guard = setTimeout(() => {
    aborted = true;
  }, config.http.requestTimeoutMs);

  try {
    const history = getHistory(conversationId);
    const recentCases = getRecentCases(conversationId);

    // 「这个案例后来效果如何」这类追问本身几乎没有可检索信息，
    // 用上一轮的案例号改写查询 + 提权该案例的分块，否则会漂到别的案例上。
    const boostCases = isAnaphora(query) ? recentCases : [];
    let retrievalQuery = query;
    if (boostCases.length) {
      const brief = caseBrief(boostCases[0]);
      if (brief) retrievalQuery = `${brief} ${query}`;
    }

    const { hits, embedMs, degraded } = await retrieve(retrievalQuery, config.retrieval.topK, { boostCases });
    const messages = buildMessages({ query, hits, history, recentCases });

    let chars = 0;
    const { text, usage } = await streamAnswer({
      messages,
      onDelta: (delta) => {
        if (aborted) return;
        chars += delta.length;
        stream.delta(res, delta);
      },
      isAborted: () => aborted,
    });

    clearTimeout(guard);

    if (!aborted && !text.trim()) {
      return stream.error(res, '模型没有返回内容，请换个问法再试。');
    }

    if (!aborted) {
      appendTurn(conversationId, 'user', query);
      appendTurn(conversationId, 'assistant', text.trim());

      // 同一案例可能命中多个块，前端标签按案例号去重，这里也先去重（保留最高分那块）
      const seenCase = new Set();
      const resources = [];
      for (const h of hits) {
        if (seenCase.has(h.caseNo)) continue;
        seenCase.add(h.caseNo);
        resources.push({
          // 前端会从 document_name / content 里正则抽 NO.x，拼成案例页链接
          document_name: `${h.caseNo} ${h.short}`,
          content: h.text,
          score: h.score,
          dataset_name: 'FDE案例100',
          segment_id: h.id,
        });
      }

      stream.end(res, {
        conversationId,
        messageId: rid,
        resources,
        usage: usage || null,
      });
    }

    console.log(
      JSON.stringify({
        rid,
        ok: true,
        ms: Date.now() - t0,
        embedMs,
        degraded,
        hits: hits.length,
        top: hits[0]?.caseNo || null,
        chars,
        conv: conversationId.slice(0, 12),
      })
    );
  } catch (err) {
    clearTimeout(guard);
    console.error(JSON.stringify({ rid, ok: false, ms: Date.now() - t0, error: err.message }));
    if (!res.headersSent) {
      return res.status(502).json({ error: '生成失败：' + err.message });
    }
    if (!res.writableEnded) stream.error(res, '生成过程中断，请重试或换个问法。');
  }
});

app.use((req, res) => res.status(404).json({ error: '未知路径，可用：POST /api/chat、GET /health' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: '请求不是合法 JSON' });
  console.error('[fde-agent] 未处理异常：', err?.message);
  if (!res.headersSent) res.status(500).json({ error: '服务内部错误' });
});

const server = app.listen(config.port, () => {
  console.log(`[fde-agent] listening on ${config.port}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[fde-agent] ${sig} 收到，优雅退出`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000);
  });
}
