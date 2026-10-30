/**
 * Dify 兼容的 SSE 编码层。
 *
 * 目的：前端 assets/chat.js 一行不改 —— 它只认下面这几种事件。
 *   {"event":"workflow_started"}                      → 界面显示「正在整理答案…」
 *   {"event":"message","answer":"片段"}                → 追加渲染
 *   {"event":"message_end","conversation_id","metadata":{"retriever_resources":[...]}}
 *   {"event":"error","message":"..."}
 */

export function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function send(res, payload) {
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

export const stream = {
  started(res) {
    send(res, { event: 'workflow_started', task_id: 'local', workflow_run_id: 'local' });
  },
  delta(res, text) {
    if (!text) return;
    send(res, { event: 'message', answer: text });
  },
  end(res, { conversationId, messageId, resources, usage }) {
    send(res, {
      event: 'message_end',
      id: messageId,
      conversation_id: conversationId,
      metadata: {
        retriever_resources: resources,
        usage,
      },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  },
  error(res, message) {
    send(res, { event: 'error', status: 500, code: 'agent_error', message });
    res.write('data: [DONE]\n\n');
    res.end();
  },
};
