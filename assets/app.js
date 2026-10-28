/* FDE 案例 100 — 站点交互：搜索 / 行业筛选 / 阅读进度 / 侧边目录 */
(function () {
  'use strict';

  /* ---------------------------------------------------------- 工具 */
  var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  var norm = function (s) {
    return String(s || '').toLowerCase().replace(/[\s\u3000]+/g, '');
  };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* 切词：中文按二元组，英文/数字按整词 */
  function tokenize(q) {
    var s = String(q || '').toLowerCase();
    var tokens = [];
    var ascii = s.match(/[a-z0-9][a-z0-9+#.\-]*/g) || [];
    ascii.forEach(function (w) {
      if (w.length > 1) tokens.push(w);
    });
    var cjk = s.replace(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g, ' ');
    cjk.split(/\s+/).forEach(function (seg) {
      if (!seg) return;
      if (seg.length === 1) tokens.push(seg);
      for (var i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
    });
    return tokens.filter(function (t, i, a) { return a.indexOf(t) === i; });
  }

  function count(hay, needle) {
    var n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
    return n;
  }

  /* ---------------------------------------------------------- 搜索 */
  var overlay = document.getElementById('search-overlay');
  var input = document.getElementById('search-input');
  var resultsEl = document.getElementById('search-results');
  var hintEl = document.getElementById('search-hint');
  var docs = null;
  var sel = -1;

  /* 检索索引约 400KB，按需加载：首次打开搜索时拉取，空闲时预取 */
  var indexLoading = false;
  var indexWaiters = [];

  function withIndex(cb) {
    if (window.SEARCH_INDEX) { cb(); return; }
    indexWaiters.push(cb);
    if (indexLoading) return;
    indexLoading = true;
    var s = document.createElement('script');
    s.src = (document.body.dataset.root || '') + 'assets/search-index.js';
    s.onload = function () {
      indexLoading = false;
      indexWaiters.splice(0).forEach(function (f) { f(); });
    };
    s.onerror = function () {
      indexLoading = false;
      indexWaiters.length = 0;
      if (hintEl) hintEl.textContent = '检索索引加载失败，请检查网络后刷新重试。';
    };
    document.head.appendChild(s);
  }

  function prepare() {
    if (docs || !window.SEARCH_INDEX) return;
    docs = window.SEARCH_INDEX.map(function (d) {
      var text = norm(d.x);
      return { t: d.t, k: d.k, u: d.u, x: d.x, n: norm(d.t + ' ' + d.x), len: text.length };
    });
  }

  function snippet(d, tokens) {
    var raw = d.x;
    var low = raw.toLowerCase();
    var pos = -1;
    for (var i = 0; i < tokens.length; i++) {
      var p = low.indexOf(tokens[i]);
      if (p !== -1 && (pos === -1 || p < pos)) pos = p;
    }
    var start = pos > 55 ? pos - 55 : 0;
    var piece = raw.slice(start, start + 150).replace(/\s+/g, ' ');
    if (start > 0) piece = '…' + piece;
    if (start + 150 < raw.length) piece += '…';
    var out = esc(piece);
    tokens.slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (t) {
      var safe = esc(t);
      if (safe.length > 1) out = out.split(safe).join('<mark>' + safe + '</mark>');
    });
    return out;
  }

  function render(list, tokens) {
    if (!list.length) {
      resultsEl.innerHTML = '<li class="search-empty">没有匹配结果，换个更短的关键词试试。</li>';
      return;
    }
    resultsEl.innerHTML = list.map(function (d, i) {
      var kind = d.k ? '<span class="result-kind">' + esc(d.k) + '</span>' : '';
      var cls = i === 0 ? ' class="is-sel"' : '';
      return '<li' + cls + '><a href="' + d.u + '"><div class="result-top">' + kind +
        '<span class="result-title">' + esc(d.t) + '</span></div>' +
        '<p class="result-snippet">' + snippet(d, tokens) + '</p></a></li>';
    }).join('');
    sel = 0;
  }

  function search(q) {
    if (!window.SEARCH_INDEX) {
      if (!norm(q)) return;
      hintEl.textContent = '正在加载检索索引…';
      withIndex(function () { search(q); });
      return;
    }
    prepare();
    var query = norm(q);
    if (!query || !docs) {
      resultsEl.innerHTML = '';
      hintEl.textContent = '输入关键词，例如「OCR」「财务对账」「知识库」';
      return;
    }
    var tokens = tokenize(query);
    if (!tokens.length) { render([], tokens); return; }

    var scored = docs.map(function (d) {
      var score = 0;
      tokens.forEach(function (t) {
        var c = count(d.n, t);
        if (c) score += c * (1 + Math.log(t.length));
      });
      if (score > 0) {
        if (d.n.indexOf(query) !== -1) score += 6;
        tokens.forEach(function (t) {
          if (d.t.toLowerCase().indexOf(t) !== -1) score += 5;
        });
        score = score / (1 + Math.log(1 + d.len / 420));
      }
      return { d: d, s: score };
    }).filter(function (o) { return o.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .map(function (o) { return o.d; });

    /* 同一案例最多保留 2 条，避免整屏被一个案例占满 */
    var seen = {};
    var picked = [];
    for (var i = 0; i < scored.length && picked.length < 15; i++) {
      var base = scored[i].u.split('#')[0];
      seen[base] = (seen[base] || 0) + 1;
      if (seen[base] <= 2) picked.push(scored[i]);
    }
    scored = picked;

    hintEl.textContent = scored.length
      ? '找到 ' + scored.length + ' 段内容 · ↑↓ 选择 · Enter 打开'
      : '没有匹配结果';
    render(scored, tokens);
  }

  function openSearch() {
    if (!overlay) return;
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    input.focus();
    input.select();
    withIndex(function () {
      if (input.value.trim()) search(input.value);
    });
  }

  function closeSearch() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.style.overflow = '';
  }

  if (overlay) {
    document.getElementById('search-open').addEventListener('click', openSearch);
    input.addEventListener('input', function () { search(input.value); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSearch(); });

    document.addEventListener('keydown', function (e) {
      var openKey = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey);
      if (openKey) { e.preventDefault(); openSearch(); return; }
      if (overlay.hidden) {
        if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); openSearch(); }
        return;
      }
      if (e.key === 'Escape') { closeSearch(); return; }
      var items = resultsEl.querySelectorAll('a');
      if (!items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        for (var i = 0; i < items.length; i++) items[i].parentNode.classList.toggle('is-sel', i === sel);
        items[sel].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[sel]) window.location.href = items[sel].getAttribute('href');
      }
    });
  }

  /* ---------------------------------------------------------- 行业筛选 */
  var chips = document.getElementById('chips');
  if (chips) {
    var cards = Array.prototype.slice.call(document.querySelectorAll('#cards .card'));
    var empty = document.getElementById('empty');
    chips.addEventListener('click', function (e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      Array.prototype.forEach.call(chips.querySelectorAll('.chip'), function (b) {
        b.classList.toggle('is-on', b === btn);
      });
      var ind = btn.dataset.ind;
      var shown = 0;
      cards.forEach(function (c) {
        var ok = ind === '*' || c.dataset.ind === ind;
        c.hidden = !ok;
        if (ok) shown++;
      });
      if (empty) empty.hidden = shown > 0;
    });
  }

  /* ---------------------------------------------------------- 阅读进度 */
  var bar = document.getElementById('progress');
  if (bar) {
    var onScroll = function () {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      var p = h > 0 ? Math.min(1, window.scrollY / h) : 0;
      bar.style.transform = 'scaleX(' + p + ')';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
  }

  /* ---------------------------------------------------------- 侧边目录高亮 */
  var toc = document.getElementById('toc');
  if (toc) {
    var sections = document.querySelectorAll('.qa[id]');
    var links = {};
    Array.prototype.forEach.call(toc.querySelectorAll('a'), function (a) {
      links[a.dataset.target] = a;
    });
    if ('IntersectionObserver' in window && sections.length) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          Object.keys(links).forEach(function (k) {
            links[k].classList.toggle('is-active', k === en.target.id);
          });
        });
      }, { rootMargin: '-88px 0px -70% 0px', threshold: 0 });
      Array.prototype.forEach.call(sections, function (s) { io.observe(s); });
    }
  }

  /* ---------------------------------------------------------- 锚点复制 */
  Array.prototype.forEach.call(document.querySelectorAll('.q-anchor'), function (a) {
    a.addEventListener('click', function (e) {
      if (!navigator.clipboard) return;
      e.preventDefault();
      var hash = a.getAttribute('href');
      var url = location.origin + location.pathname + hash;
      history.replaceState(null, '', hash);
      navigator.clipboard.writeText(url).then(function () {
        var old = a.textContent;
        a.textContent = '已复制';
        setTimeout(function () { a.textContent = old; }, 1200);
      });
    });
  });

  /* ---------------------------------------------------------- 移动端案例跳转 */
  var jump = document.getElementById('case-jump');
  if (jump) {
    jump.addEventListener('change', function () {
      if (jump.value) window.location.href = jump.value;
    });
  }

  /* ---------------------------------------------------------- 空闲预取检索索引 */
  var prefetch = function () { withIndex(function () {}); };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(prefetch, { timeout: 4000 });
  } else {
    setTimeout(prefetch, 2000);
  }
})();
