/**
 * 检索：启动时把 168 个块的向量读进内存，查询时算余弦（向量已 L2 归一化，余弦 = 点积）。
 * embedding 走硅基流动 HTTP API；失败时降级为纯关键词召回，不让整个请求挂掉。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let chunks = [];
let vectors = [];
let dim = 0;
let meta = {};

export function loadIndex() {
  const chunksFile = path.join(config.dataDir, 'chunks.json');
  const vectorsFile = path.join(config.dataDir, 'vectors.bin');
  const metaFile = path.join(config.dataDir, 'meta.json');

  if (!fs.existsSync(chunksFile) || !fs.existsSync(vectorsFile)) {
    throw new Error(`索引缺失：请先运行 node tools/build-agent-index.mjs（期望 ${config.dataDir}）`);
  }

  chunks = JSON.parse(fs.readFileSync(chunksFile, 'utf8'));
  meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  dim = meta.dim || 1024;

  const buf = fs.readFileSync(vectorsFile);
  if (buf.length !== chunks.length * dim * 4) {
    throw new Error(`索引尺寸不匹配：${buf.length} 字节，期望 ${chunks.length} × ${dim} × 4`);
  }
  vectors = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    vectors[i] = new Float32Array(buf.buffer, buf.byteOffset + i * dim * 4, dim);
  }
  return { chunks: chunks.length, dim, model: meta.model };
}

export function indexInfo() {
  return { chunks: chunks.length, dim, model: meta.model, builtAt: meta.builtAt };
}

/* ---------------------------------------------------------------- 向量 */
function normalize(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const n = Math.sqrt(sum) || 1;
  return vec.map((v) => v / n);
}

async function embedQuery(text) {
  const { baseURL, apiKey, model, timeoutMs } = config.embedding;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(baseURL + '/embeddings', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: [text], encoding_format: 'float' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return normalize(data.data[0].embedding);
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- 关键词兜底 */
const CJK = /[\u4e00-\u9fff]/;
function bigrams(text) {
  const s = String(text).toLowerCase().replace(/[\s\u3000]+/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    if (CJK.test(s[i]) || CJK.test(s[i + 1])) out.add(s.slice(i, i + 2));
    else out.add(s.slice(i, i + 2));
  }
  return out;
}

function keywordScore(queryGrams, text) {
  const grams = bigrams(text);
  let hit = 0;
  for (const g of queryGrams) if (grams.has(g)) hit++;
  return queryGrams.size ? hit / queryGrams.size : 0;
}

/* ---------------------------------------------------------------- 检索主流程 */
/** 取某案例的短标题，用于把「这个案例」类问题改写成可检索的查询 */
export function caseBrief(caseNo) {
  const hit = chunks.find((c) => c.caseNo === caseNo);
  return hit ? `${hit.caseNo} ${hit.short}` : '';
}

export async function retrieve(query, topK = config.retrieval.topK, options = {}) {
  const qGrams = bigrams(query);
  let qVec = null;
  let embedMs = 0;

  const t0 = Date.now();
  try {
    qVec = await embedQuery(query);
  } catch (err) {
    console.warn('[retriever] embedding 失败，降级为关键词召回：', err.message);
  }
  embedMs = Date.now() - t0;

  const boost = config.retrieval.keywordBoost;
  const focus = new Set(options.boostCases || []); // 指代追问时，把上下文里的案例往上抬
  const scored = chunks.map((c, i) => {
    const cosine = qVec ? dot(qVec, vectors[i]) : 0;
    const kw = keywordScore(qGrams, c.text);
    let score = qVec ? cosine + boost * kw : kw;
    if (focus.has(c.caseNo)) score += 0.18;
    return { chunk: c, score, cosine, kw };
  });

  scored.sort((a, b) => b.score - a.score);

  const picked = scored.slice(0, topK).filter((s) => s.score >= config.retrieval.minScore || s.kw > 0.2);
  return {
    hits: picked.map((s) => ({
      id: s.chunk.id,
      caseNo: s.chunk.caseNo,
      caseTitle: s.chunk.caseTitle,
      short: s.chunk.short,
      label: s.chunk.label,
      text: s.chunk.text,
      score: Number(s.score.toFixed(4)),
      cosine: Number(s.cosine.toFixed(4)),
      keyword: Number(s.kw.toFixed(3)),
    })),
    embedMs,
    degraded: !qVec,
  };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
