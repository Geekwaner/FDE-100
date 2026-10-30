/**
 * 配置：全部来自环境变量（容器里由 CloudBase 注入），本地开发从项目根 .env 兜底。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function readDotEnv() {
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

const dotenv = readDotEnv();
const pick = (key, fallback = '') => process.env[key] ?? dotenv[key] ?? fallback;
const num = (key, fallback) => Number(pick(key, String(fallback)));

export const config = {
  port: num('PORT', 8080),

  llm: {
    apiKey: pick('SILICONFLOW_API_KEY'),
    baseURL: pick('SILICONFLOW_BASE_URL', 'https://api.siliconflow.cn/v1').replace(/\/$/, ''),
    model: pick('SILICONFLOW_MODEL', 'Qwen/Qwen3.8-27B'),
    temperature: Number(pick('AGENT_TEMPERATURE', '0.3')),
    // Qwen3 系列默认开思考：实测首字 3.4s → 0.4s、总耗时 3.9s → 0.9s，
    // 且思考 token 会吃掉 maxOutputTokens 导致正文为空，所以默认关闭。
    thinking: pick('AGENT_THINKING', '0') === '1',
    maxTokens: num('AGENT_MAX_TOKENS', 900),
  },

  embedding: {
    apiKey: pick('SILICONFLOW_API_KEY'),
    baseURL: pick('SILICONFLOW_BASE_URL', 'https://api.siliconflow.cn/v1').replace(/\/$/, ''),
    model: pick('SILICONFLOW_EMBEDDING_MODEL', 'BAAI/bge-m3'),
    timeoutMs: num('EMBED_TIMEOUT_MS', 8000),
  },

  retrieval: {
    topK: num('RETRIEVAL_TOP_K', 6),
    minScore: Number(pick('RETRIEVAL_MIN_SCORE', '0.25')),
    keywordBoost: Number(pick('RETRIEVAL_KEYWORD_BOOST', '0')), // 专有名词召回不稳时调大，如 0.15
  },

  agent: {
    allowTools: pick('AGENT_ALLOW_TOOLS', '0') === '1',
    historyTurns: num('HISTORY_TURNS', 6),
  },

  http: {
    allowOrigin: pick('ALLOW_ORIGIN', '*').split(',').map((s) => s.trim()).filter(Boolean),
    perMin: num('RATE_LIMIT_PER_MIN', 20),
    perDay: num('RATE_LIMIT_PER_DAY', 100),
    globalDaily: num('GLOBAL_DAILY_CAP', 500),
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 90_000),
  },

  dataDir: path.resolve(import.meta.dirname, '..', 'data'),
};

export function assertConfig() {
  const missing = [];
  if (!config.llm.apiKey) missing.push('SILICONFLOW_API_KEY');
  if (!config.llm.baseURL) missing.push('SILICONFLOW_BASE_URL');
  if (!config.llm.model) missing.push('SILICONFLOW_MODEL');
  return missing;
}
