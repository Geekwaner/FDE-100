/* AI 问答前端：直连自建代理（/api/chat），SSE 流式渲染，多轮对话记忆 */
(function () {
  'use strict';

  var API = document.body.dataset.api || '/api/chat';
  var log = document.getElementById('chat-log');
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-input');
  var sendBtn = document.getElementById('chat-send');
  var stopBtn = document.getElementById('chat-stop');
  var resetBtn = document.getElementById('chat-reset');
  if (!log || !form) return;

  var PRESETS = [
    '制造业那家德国企业是怎么把老师傅经验留下来的？',
    'FDE 一般怎么发现真正的需求？',
    'AI 落地最常见的阻力是什么，FDE 怎么处理？',
    '有哪些跨境电商相关的案例？'
  ];

  var store = 'fde-chat-v1';
  var state = { convId: '', messages: [], busy: false, ctrl: null };

  /* ---------------------------------------------------------- 工具 */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 去掉推理模型的思考过程：<think>…</think>、<!--dify-deepseek-reasoning--> 注释 */
  function visible(s) {
    var t = String(s || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<think[\s\S]*?<\/think>/gi, '');
    var open = t.search(/<think[^>]*>/i);
    if (open >= 0) t = t.slice(0, open); // 还在思考中，先不显示
    return t.replace(/<\/?think>/gi, '');
  }

  /* 极简 Markdown：段落、列表、加粗、行内代码 */
  function render(text) {
    var lines = String(text || '').split(/\r?\n/);
    var out = [];
    var buf = [];
    var listType = null;

    function flushPara() {
      if (!buf.length) return;
      out.push('<p>' + buf.map(inl).join('<br>') + '</p>');
      buf = [];
    }
    function closeList() {
      if (listType) {
        out.push('</' + listType + '>');
        listType = null;
      }
    }
    function inl(s) {
      return esc(s)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+?)`/g, '<code>$1</code>');
    }

    lines.forEach(function (line) {
      var t = line.trim();
      if (!t) {
        flushPara();
        closeList();
        return;
      }
      var m = t.match(/^(?:[-*·]|(\d+)[.)])\s+(.*)$/);
      if (m) {
        flushPara();
        var want = m[1] ? 'ol' : 'ul';
        if (listType !== want) {
          closeList();
          out.push('<' + want + '>');
          listType = want;
        }
        out.push('<li>' + inl(m[2]) + '</li>');
        return;
      }
      if (listType) closeList();
      buf.push(t);
    });
    flushPara();
    closeList();
    return out.join('');
  }

  function save() {
    try {
      sessionStorage.setItem(store, JSON.stringify({ c: state.convId, m: state.messages }));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function load() {
    try {
      var raw = sessionStorage.getItem(store);
      if (!raw) return false;
      var data = JSON.parse(raw);
      state.convId = data.c || '';
      state.messages = Array.isArray(data.m) ? data.m : [];
      return state.messages.length > 0;
    } catch (e) { return false; }
  }

  /* ---------------------------------------------------------- 渲染 */
  function bubble(role) {
    var row = document.createElement('div');
    row.className = 'msg msg--' + role;
    var body = document.createElement('div');
    body.className = 'msg-body';
    row.appendChild(body);
    log.appendChild(row);
    scrollBottom();
    return { row: row, body: body };
  }

  /* 引用来源：优先从检索到的分块里认出 NO.x，链到对应案例页；认不出就返回 0 条 */
  function sources(el, list) {
    if (!list || !list.length) return 0;
    var box = document.createElement('div');
    box.className = 'msg-sources';
    var head = document.createElement('span');
    head.className = 'src-label';
    head.textContent = '来源';
    box.appendChild(head);

    var seen = {};
    var links = 0;
    list.slice(0, 5).forEach(function (r) {
      var name = (r.document_name || r.dataset_name || '').trim();
      var m = name.match(/NO\.(\d+)/i) || String(r.content || '').match(/NO\.(\d+)/i);
      if (!m || seen[m[1]]) return;
      seen[m[1]] = 1;
      links += 1;
      var a = document.createElement('a');
      a.textContent = 'NO.' + m[1];
      a.title = name || '案例 NO.' + m[1];
      a.href = '../cases/no-' + ('0' + m[1]).slice(-2) + '.html';
      box.appendChild(a);
    });

    if (!links) return 0;
    el.appendChild(box);
    return links;
  }

  /* Dify 没回传 retriever_resources 时，退化成「从答案里认出 NO.x」并链到案例页 */
  function citedCases(el, text) {
    var seen = {};
    var ids = String(text).match(/NO\.\d+/gi) || [];
    if (!ids.length) return;
    var box = document.createElement('div');
    box.className = 'msg-sources';
    ids.forEach(function (id) {
      var key = id.toUpperCase();
      if (seen[key]) return;
      seen[key] = 1;
      var n = key.split('.')[1];
      var a = document.createElement('a');
      a.textContent = key;
      a.href = '../cases/no-' + ('0' + n).slice(-2) + '.html';
      box.appendChild(a);
    });
    box.appendChild(Object.assign(document.createElement('span'), {
      textContent: '文中引用的案例',
      style: 'background:transparent;color:var(--muted)'
    }));
    el.appendChild(box);
  }

  function scrollBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function renderHistory() {
    log.innerHTML = '';
    state.messages.forEach(function (m) {
      var b = bubble(m.role);
      b.body.innerHTML = render(m.text);
      if (m.sources) sources(b.body, m.sources);
    });
    scrollBottom();
  }

  function presets() {
    var box = document.createElement('div');
    box.className = 'chat-presets';
    PRESETS.forEach(function (q) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-preset';
      btn.textContent = q;
      btn.addEventListener('click', function () {
        box.remove();
        input.value = q;
        submit();
      });
      box.appendChild(btn);
    });
    log.appendChild(box);
  }

  function status(text) {
    var el = log.querySelector('.msg--status');
    if (!el) {
      el = document.createElement('div');
      el.className = 'msg msg--status';
      el.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="status-text"></span>';
      log.appendChild(el);
    }
    el.querySelector('.status-text').textContent = text ? ' ' + text : '';
    scrollBottom();
  }

  function clearStatus() {
    var el = log.querySelector('.msg--status');
    if (el) el.remove();
  }

  function errorBox(text) {
    var el = document.createElement('div');
    el.className = 'msg msg--error';
    el.textContent = text;
    log.appendChild(el);
    scrollBottom();
  }

  /* ---------------------------------------------------------- 发送 */
  function setBusy(v) {
    state.busy = v;
    sendBtn.hidden = v;
    stopBtn.hidden = !v;
    input.disabled = v;
  }

  function submit() {
    var q = input.value.trim();
    if (!q || state.busy) return;
    input.value = '';
    input.style.height = 'auto';
    var preset = log.querySelector('.chat-presets');
    if (preset) preset.remove();

    state.messages.push({ role: 'user', text: q });
    var ub = bubble('user');
    ub.body.innerHTML = render(q);
    save();

    var ab = bubble('assistant');
    status('正在检索案例库…');
    setBusy(true);

    var answer = '';
    var srcList = null;
    var ctrl = new AbortController();
    state.ctrl = ctrl;

    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, conversation_id: state.convId, user: 'web' }),
      signal: ctrl.signal
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error(j.error || ('HTTP ' + res.status));
          e.status = res.status;
          /* 服务端给了可读文案（如限流提示）就直接展示，不再套"请求失败：" */
          e.userFacing = j.error || '';
          throw e;
        });
      }
      /* 代理若被平台缓冲（拿不到 SSE），退化成一次性返回 JSON */
      var ctype = (res.headers && res.headers.get('content-type')) || '';
      if (ctype.indexOf('text/event-stream') === -1) {
        return res.json().then(function (d) {
          answer = (d && d.answer) || '';
          if (d && d.conversation_id) state.convId = d.conversation_id;
          srcList = d && d.metadata && d.metadata.retriever_resources;
          var t = visible(answer).trim();
          if (t) {
            clearStatus();
            ab.body.innerHTML = render(t);
            scrollBottom();
          }
        });
      }
      if (!res.body) throw new Error('当前浏览器不支持流式读取');

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';

      function handleChunk(chunk) {
        chunk.split(/\r?\n/).forEach(function (line) {
          if (line.indexOf('data:') !== 0) return;
          var data = line.slice(5).trim();
          if (!data || data === '[DONE]') return;
          var ev;
          try { ev = JSON.parse(data); } catch (e) { return; }
          onEvent(ev);
        });
      }

      function onEvent(ev) {
        if (ev.event === 'workflow_started' || ev.event === 'node_started') {
          status('正在整理答案…');
        } else if (ev.event === 'message' || ev.event === 'agent_message') {
          answer += ev.answer || '';
          var shown = visible(answer);
          if (shown.trim()) {
            clearStatus();
            ab.body.innerHTML = render(shown);
            scrollBottom();
          }
        } else if (ev.event === 'message_end') {
          state.convId = ev.conversation_id || state.convId;
          srcList = ev.metadata && ev.metadata.retriever_resources;
        } else if (ev.event === 'error') {
          throw new Error(ev.message || '生成出错');
        }
      }

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += decoder.decode(r.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            handleChunk(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
          return pump();
        });
      }
      return pump();
    }).then(function () {
      clearStatus();
      var finalText = visible(answer).trim();
      if (finalText) {
        ab.body.innerHTML = render(finalText);
        if (!sources(ab.body, srcList)) citedCases(ab.body, finalText);
        state.messages.push({ role: 'assistant', text: finalText, sources: srcList });
      } else {
        ab.row.remove();
        errorBox('没有收到回答，请重试。');
      }
      save();
    }).catch(function (err) {
      clearStatus();
      if (err.name === 'AbortError') {
        var partial = visible(answer).trim();
        ab.body.innerHTML = render(partial + '\n\n（已停止生成）');
        if (partial) state.messages.push({ role: 'assistant', text: partial });
        save();
      } else {
        if (!answer) ab.row.remove();
        if (err.userFacing) {
          errorBox(err.userFacing);
        } else {
          var offline = /404|Failed to fetch|NetworkError|502|503/i.test(err.message);
          errorBox(
            offline
              ? '问答服务暂时不可用（后端未连接）。可以稍后重试，或先用站内搜索查原文。'
              : '请求失败：' + err.message
          );
        }
        console.error('[chat]', err);
      }
    }).then(function () {
      state.ctrl = null;
      setBusy(false);
      input.focus();
    });
  }

  /* ---------------------------------------------------------- 事件 */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    submit();
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  stopBtn.addEventListener('click', function () {
    if (state.ctrl) state.ctrl.abort();
  });

  resetBtn.addEventListener('click', function () {
    if (state.busy && state.ctrl) state.ctrl.abort();
    state.convId = '';
    state.messages = [];
    try { sessionStorage.removeItem(store); } catch (e) {}
    log.innerHTML = '';
    presets();
    input.focus();
  });

  if (load()) renderHistory();
  else presets();
  input.focus();
})();
