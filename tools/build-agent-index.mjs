/**
 * 构建 Agent 检索索引：把 RAG 版 Markdown 切成语义块 → 调 embedding → 写二进制向量。
 *
 * 用法：
 *   node tools/build-agent-index.mjs              # 增量：只补齐缺失/变更的块
 *   node tools/build-agent-index.mjs --rebuild    # 全量重建
 *
 * 产物（提交入库，随镜像打包，运行时零 DB 依赖）：
 *   cloudrun/agent/data/chunks.json   块元数据
 *   cloudrun/agent/data/vectors.bin   Float32 小端，L2 归一化后的向量（cos = 点积）
 *   cloudrun/agent/data/meta.json     模型名、维度、块数、构建时间
 *
 * 依赖：只用 Node 内置能力（Node 18+），密钥从项目根 .env 读取。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_MD = path.join(ROOT, 'Datawhale-FDE案例100-纯文字-RAG版.md');
const OUT_DIR = path.join(ROOT, 'cloudrun', 'agent', 'data');
const CHUNKS_FILE = path.join(OUT_DIR, 'chunks.json');
const VECTORS_FILE = path.join(OUT_DIR, 'vectors.bin');
const META_FILE = path.join(OUT_DIR, 'meta.json');

const REBUILD = process.argv.includes('--rebuild');
const BATCH = 16;
const RETRY = 3;

/* ---------------------------------------------------------------- 配置 */
function readEnv() {
  const file = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = readEnv();
const KEY = process.env.SILICONFLOW_API_KEY || env.SILICONFLOW_API_KEY;
const BASE = (process.env.SILICONFLOW_BASE_URL || env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
const EMBED_MODEL = process.env.SILICONFLOW_EMBEDDING_MODEL || env.SILICONFLOW_EMBEDDING_MODEL || 'BAAI/bge-m3';

if (!KEY) {
  console.error('缺少 SILICONFLOW_API_KEY（.env 或环境变量）');
  process.exit(1);
}

/* ---------------------------------------------------------------- 切块 */
const RE_CASE = /^##\s+(NO\.\d+)\s*(.+)$/;
const RE_Q = /^###\s+(Q\d+)\s*\[(NO\.\d+)\s+([^\]]+)\]\s*[：:]\s*(.+)$/;

const Q_SHORT = {
  Q1: '场景与问题',
  Q2: '过去做法',
  Q3: '方案与步骤',
  Q4: '实际效果',
  Q5: '挑战与解决',
  Q6: '经验建议',
};

function parse(md) {
  const cases = [];
  let cur = null;
  let curQ = null;
  let sect = null;
  let inAppendix = false;

  for (const raw of md.split(/\r?\n/)) {
    const s = raw.trim();

    if (s.startsWith('# 附录')) {
      inAppendix = true;
      continue;
    }
    if (inAppendix) {
      if (s.startsWith('# ')) inAppendix = false;
      continue;
    }

    const mc = s.match(RE_CASE);
    if (mc) {
      curQ = null;
      sect = null;
      cur = {
        no: mc[1],
        title: mc[2].trim(),
        tags: '',
        speaker: '',
        quote: '',
        summary: [],
        audience: [],
        qas: [],
      };
      cases.push(cur);
      continue;
    }
    if (!cur) continue;

    const mq = s.match(RE_Q);
    if (mq) {
      curQ = { label: mq[1], q: mq[4].trim(), body: [] };
      cur.qas.push(curQ);
      sect = null;
      continue;
    }
    if (s.startsWith('### ') || s.startsWith('## ')) continue;
    if (!s) continue;

    if (s.startsWith('**案例标签**')) {
      cur.tags = s.split('：').slice(1).join('：').replace('（RAG版修正）', '').trim();
      continue;
    }
    if (s.startsWith('**讲述人**')) {
      cur.speaker = s.split('：').slice(1).join('：').trim();
      continue;
    }
    if (s === '**案例简介**') {
      sect = 'summary';
      continue;
    }
    if (s === '**适用人群**') {
      sect = 'audience';
      continue;
    }
    if (s.startsWith('**案例编号**') || s.startsWith('**封面标题**')) continue;
    if (s === '---') continue;

    if (s.startsWith('> ')) {
      if (curQ) curQ.body.push(s.slice(2).trim());
      else if (!cur.quote) cur.quote = s.slice(2).trim();
      continue;
    }
    if (s.startsWith('- ')) {
      if (sect === 'audience') cur.audience.push(s.slice(2).trim());
      else if (curQ) curQ.body.push('· ' + s.slice(2).trim());
      continue;
    }

    if (curQ) curQ.body.push(s);
    else if (sect === 'summary') cur.summary.push(s);
    else if (sect === 'audience') cur.audience.push(s);
  }
  return cases;
}

function buildChunks(cases) {
  const chunks = [];
  for (const c of cases) {
    const short = c.title.split('：')[0].split(':')[0].trim();
    const slug = c.no.toLowerCase().replace('.', '-');

    chunks.push({
      id: `${slug}-sum`,
      caseNo: c.no,
      caseTitle: c.title,
      short,
      kind: 'summary',
      label: '案例简介',
      q: '',
      text: [
        `${c.no} ${c.title}`,
        `标签：${c.tags}`,
        `讲述人：${c.speaker}`,
        `简介：${c.summary.join('')}`,
        c.audience.length ? `适用人群：${c.audience.join('；')}` : '',
        c.quote ? `原话：${c.quote}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    for (const qa of c.qas) {
      chunks.push({
        id: `${slug}-${qa.label.toLowerCase()}`,
        caseNo: c.no,
        caseTitle: c.title,
        short,
        kind: 'qa',
        label: `${qa.label} ${Q_SHORT[qa.label] || ''}`.trim(),
        q: qa.q,
        text: [`【${c.no} ${short}】${qa.label} ${Q_SHORT[qa.label] || ''}`, `问题：${qa.q}`, qa.body.join('\n')].join('\n'),
      });
    }
  }
  return chunks;
}

/* ---------------------------------------------------------------- embedding */
async function embedBatch(inputs) {
  for (let attempt = 1; attempt <= RETRY; attempt++) {
    try {
      const res = await fetch(BASE + '/embeddings', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: inputs, encoding_format: 'float' }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
      const data = await res.json();
      return data.data.map((d) => d.embedding);
    } catch (err) {
      if (attempt === RETRY) throw err;
      console.warn(`  ! 第 ${attempt} 次失败：${err.message}，重试…`);
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  return [];
}

function l2norm(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const n = Math.sqrt(sum) || 1;
  return vec.map((v) => v / n);
}

async function main() {
  const md = fs.readFileSync(SRC_MD, 'utf8');
  const cases = parse(md);
  if (cases.length !== 24) throw new Error(`解析到 ${cases.length} 个案例，预期 24`);

  const chunks = buildChunks(cases);
  const totalQa = chunks.filter((c) => c.kind === 'qa').length;
  console.log(`切块：${chunks.length} 个（问答 ${totalQa} + 简介 ${chunks.length - totalQa}），embedding 模型 ${EMBED_MODEL}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 增量：读旧索引，用 text 哈希判断是否需要重算
  let oldVectors = [];
  let oldChunks = [];
  if (!REBUILD && fs.existsSync(CHUNKS_FILE) && fs.existsSync(VECTORS_FILE) && fs.existsSync(META_FILE)) {
    oldChunks = JSON.parse(fs.readFileSync(CHUNKS_FILE, 'utf8'));
    const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    const buf = fs.readFileSync(VECTORS_FILE);
    if (meta.model === EMBED_MODEL && meta.count === oldChunks.length && buf.length === meta.count * meta.dim * 4) {
      for (let i = 0; i < meta.count; i++) {
        oldVectors.push(new Float32Array(buf.buffer, buf.byteOffset + i * meta.dim * 4, meta.dim));
      }
      console.log(`已有索引：${oldChunks.length} 块，尝试复用未变更的部分`);
    } else {
      console.log('旧索引模型/维度不匹配，全量重建');
      oldChunks = [];
      oldVectors = [];
    }
  }

  const oldMap = new Map(oldChunks.map((c, i) => [c.id + '|' + hash(c.text), oldVectors[i]]));
  const vectors = new Array(chunks.length);
  const todo = [];

  chunks.forEach((c, i) => {
    const cached = oldMap.get(c.id + '|' + hash(c.text));
    if (cached) vectors[i] = cached;
    else todo.push(i);
  });

  console.log(`需计算 ${todo.length} 块（复用 ${chunks.length - todo.length} 块）`);

  let dim = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const idxs = todo.slice(i, i + BATCH);
    const inputs = idxs.map((k) => chunks[k].text);
    const out = await embedBatch(inputs);
    out.forEach((vec, j) => {
      if (!dim) dim = vec.length;
      if (vec.length !== dim) throw new Error(`维度不一致：${vec.length} vs ${dim}`);
      vectors[idxs[j]] = l2norm(vec);
    });
    process.stdout.write(`  进度 ${Math.min(i + BATCH, todo.length)}/${todo.length}\r`);
  }

  if (!dim) {
    // 全部来自缓存时，从旧 meta 取维度
    dim = JSON.parse(fs.readFileSync(META_FILE, 'utf8')).dim;
  }
  if (vectors.some((v) => !v)) throw new Error('存在未计算的块');

  const buf = Buffer.alloc(chunks.length * dim * 4);
  vectors.forEach((vec, i) => {
    for (let d = 0; d < dim; d++) buf.writeFloatLE(vec[d], (i * dim + d) * 4);
  });

  fs.writeFileSync(CHUNKS_FILE, JSON.stringify(chunks, null, 1));
  fs.writeFileSync(VECTORS_FILE, buf);
  fs.writeFileSync(
    META_FILE,
    JSON.stringify(
      {
        model: EMBED_MODEL,
        dim,
        count: chunks.length,
        normalized: true,
        builtAt: new Date().toISOString(),
        source: path.basename(SRC_MD),
      },
      null,
      1
    )
  );

  const kb = (buf.length / 1024).toFixed(0);
  console.log(`\n完成：${chunks.length} 块 × ${dim} 维 = vectors.bin ${kb} KB`);
  console.log(`  ${path.relative(ROOT, CHUNKS_FILE)}`);
  console.log(`  ${path.relative(ROOT, VECTORS_FILE)}`);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

main().catch((err) => {
  console.error('构建失败：', err.message);
  process.exit(1);
});
