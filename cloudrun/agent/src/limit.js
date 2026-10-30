/**
 * 三层限流：每 IP 每分钟 / 每 IP 每天 / 全站每天。
 * 与 cloudrun/dify-proxy/main.js 保持同一套语义与环境变量，便于两个服务行为一致。
 * 注意：计数在单实例内存，冷启动或扩容会重置 —— 用来挡滥用，不做精确配额。
 */

import { config } from './config.js';

const buckets = new Map(); // ip -> { minStart, minCount, dayKey, dayCount }
let globalDay = { key: today(), count: 0 };

function today() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); // 按 UTC+8 自然日
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

export function take(ip) {
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

  const { perMin, perDay, globalDaily } = config.http;

  if (perMin > 0 && b.minCount >= perMin) {
    const wait = Math.max(1, Math.ceil((60_000 - (now - b.minStart)) / 1000));
    return { ok: false, retry: wait, msg: `提问有点频繁，请 ${wait} 秒后再试。` };
  }
  if (perDay > 0 && b.dayCount >= perDay) {
    return { ok: false, retry: 3600, msg: '今天的提问次数已用完，明天再来吧。' };
  }
  if (globalDaily > 0 && globalDay.count >= globalDaily) {
    return { ok: false, retry: 3600, msg: '本站今日提问总量已达上限，请明天再试。' };
  }

  b.minCount += 1;
  b.dayCount += 1;
  globalDay.count += 1;

  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.dayKey !== key) buckets.delete(k);
  }
  return { ok: true };
}

export function limitStats() {
  return {
    perMin: config.http.perMin,
    perDay: config.http.perDay,
    globalDaily: config.http.globalDaily,
    globalUsedToday: globalDay.count,
    trackedIps: buckets.size,
  };
}
