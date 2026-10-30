/**
 * 会话记忆：实例内 LRU。
 *
 * 为什么不用数据库：容器 MinNum=0 会缩容，本地盘不可靠；而 CloudBase PG 是 SHARED 租户，
 * 容器内没有 TCP 直连，走 HTTP API 会给每次对话多加一跳与一套鉴权。
 * 这套问答单轮即可用，多轮只影响"这个案例"这类指代，权衡后先用内存 +
 * conversation_id 保住热实例内的连续追问，冷启动丢上下文可接受。
 * 需要持久化时，把 get/append 换成 PG 实现即可，接口不变。
 */

import { randomUUID } from 'node:crypto';

const MAX_SESSIONS = 200;
const MAX_TURNS = 12; // 6 轮
const TTL_MS = 60 * 60 * 1000;

const sessions = new Map(); // id -> { turns: [{role,content}], updatedAt }

export function newConversationId() {
  return 'conv_' + randomUUID().replace(/-/g, '').slice(0, 20);
}

export function getHistory(id) {
  const s = touch(id);
  return s ? s.turns.slice() : [];
}

/** 最近提到的案例编号（新→旧），用于解析「这个案例」这类指代 */
export function getRecentCases(id) {
  const s = touch(id);
  return s ? s.cases.slice() : [];
}

function touch(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.updatedAt > TTL_MS) {
    sessions.delete(id);
    return null;
  }
  sessions.delete(id);
  sessions.set(id, s); // 重新插入 = 触碰 LRU
  return s;
}

export function appendTurn(id, role, content) {
  if (!id || !content) return;
  let s = sessions.get(id);
  if (!s) {
    s = { turns: [], cases: [], updatedAt: Date.now() };
    sessions.set(id, s);
  }
  s.turns.push({ role, content });
  if (s.turns.length > MAX_TURNS) s.turns = s.turns.slice(-MAX_TURNS);

  if (role === 'assistant') {
    // 记录回答里引用过的案例，供下一轮指代解析
    const found = [...new Set(content.match(/NO\.\d+/g) || [])];
    s.cases = [...found, ...s.cases.filter((c) => !found.includes(c))].slice(0, 3);
  }

  s.updatedAt = Date.now();
  sessions.delete(id);
  sessions.set(id, s);

  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
}

export function memoryStats() {
  return { sessions: sessions.size, maxSessions: MAX_SESSIONS, maxTurns: MAX_TURNS };
}
