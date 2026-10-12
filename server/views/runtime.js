// View side of the MCP Apps protocol, without a framework. The host draws a view from a tool
// result; there is no live channel back, so every update arrives as a fresh tool result.
(function () {
  'use strict';
  const PROTOCOL = '2026-01-26';
  const MODES = ['inline', 'fullscreen'];
  const parent = window.parent;
  let nextId = 1;
  const pending = new Map();
  const state = { hostModes: [], displayMode: 'inline', result: null };

  function post(msg) {
    parent.postMessage(Object.assign({ jsonrpc: '2.0' }, msg), '*');
  }
  function request(method, params) {
    const id = nextId++;
    post({ id: id, method: method, params: params });
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
    });
  }
  function notify(method, params) {
    post({ method: method, params: params || {} });
  }

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme === 'dark' || ctx.theme === 'light') document.documentElement.dataset.theme = ctx.theme;
    if (Array.isArray(ctx.availableDisplayModes)) state.hostModes = ctx.availableDisplayModes;
    if (ctx.displayMode) state.displayMode = ctx.displayMode;
    document.documentElement.dataset.mode = state.displayMode;
    updateExpand();
  }

  function updateExpand() {
    const btn = document.getElementById('expand');
    if (!btn) return;
    const can = state.hostModes.indexOf('fullscreen') !== -1;
    btn.hidden = !can;
    btn.textContent = state.displayMode === 'fullscreen' ? 'Back' : 'Expand';
  }

  function render() {
    const root = document.getElementById('view');
    const sc = state.result && state.result.structuredContent;
    root.replaceChildren();
    if (!sc) {
      root.append(el('p', 'muted', 'Waiting for data.'));
      return;
    }
    window.BatonView.render(root, sc, el);
  }

  /** Small element helper. Text always goes through textContent, never innerHTML. */
  function el(tag, cls, text, children) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    (children || []).forEach(function (c) { if (c) n.append(c); });
    return n;
  }

  window.addEventListener('message', function (ev) {
    if (ev.source && ev.source !== parent) return;
    const m = ev.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(m.error);
      else p.resolve(m.result);
      return;
    }
    switch (m.method) {
      case 'ui/notifications/tool-result':
        state.result = m.params;
        render();
        break;
      case 'ui/notifications/host-context-changed':
        applyContext(m.params);
        break;
      case 'ui/resource-teardown':
        post({ id: m.id, result: {} });
        break;
      default:
        if (m.id !== undefined) post({ id: m.id, error: { code: -32601, message: 'Method not found' } });
    }
  });

  document.getElementById('expand').addEventListener('click', function () {
    const want = state.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    // Only on a user click: the view never changes its own size unasked.
    request('ui/request-display-mode', { mode: want }).then(function (r) {
      applyContext({ displayMode: r && r.mode ? r.mode : state.displayMode });
    }, function () { /* host said no; stay as we are */ });
  });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () {
      notify('ui/notifications/size-changed', {
        width: Math.ceil(document.documentElement.scrollWidth),
        height: Math.ceil(document.documentElement.scrollHeight),
      });
    }).observe(document.body);
  }

  render();
  request('ui/initialize', {
    appInfo: { name: window.BatonView.name, version: '0.1.0' },
    appCapabilities: { availableDisplayModes: MODES },
    protocolVersion: PROTOCOL,
  }).then(function (r) {
    applyContext(r && r.hostContext);
    notify('ui/notifications/initialized');
  });
})();
