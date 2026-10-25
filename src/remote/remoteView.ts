/**
 * The /remote web viewer — ONE self-contained HTML file (inline CSS+JS).
 *
 * Deliberately no external assets: the sandbox gateway routes by the
 * ?XTransformPort=NNNN query param, and relative subresource requests do NOT
 * carry it. A single inline document is immune to that (and to any other
 * proxy weirdness).
 *
 * Frame streaming: plain HTTP loop — fetch('/remote/frame') returns a JPEG
 * with X-Device-Size metadata headers; the browser re-requests on load.
 * ~3–4 fps, works through ANY proxy. No WebSockets, no SSE.
 *
 * Input: every click/tap/scroll/key is POSTed to /remote/input, which
 * forwards to the server's Chrome via CDP Input.dispatch* — those arrive in
 * the page as TRUSTED input events.
 *
 * IMPORTANT: the inner JS uses string concatenation only (no template
 * literals) so this outer TypeScript template string needs no escaping.
 */

export const REMOTE_VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Remote Chrome — Gemini Headless Bridge</title>
<style>
  :root { --bg:#0b0f14; --panel:#121821; --edge:#1e2836; --text:#e6edf3; --muted:#8b98a9; --ok:#10b981; --warn:#f59e0b; --err:#ef4444; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:var(--bg); color:var(--text);
    font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; height:100%; }
  body { display:flex; flex-direction:column; }
  header { display:flex; align-items:center; gap:8px; padding:8px 12px;
    border-bottom:1px solid var(--edge); background:var(--panel); flex-wrap:wrap; }
  header h1 { font-size:13px; margin:0; font-weight:650; margin-right:auto; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--muted); flex-shrink:0; }
  .dot.ok { background:var(--ok); box-shadow:0 0 7px var(--ok); }
  .dot.err { background:var(--err); }
  #state { font-size:11.5px; color:var(--muted); font-family:ui-monospace,monospace; }
  .bar { display:flex; gap:6px; padding:8px 12px; border-bottom:1px solid var(--edge);
    background:var(--panel); flex-wrap:wrap; align-items:center; }
  .bar input[type=text] { flex:1; min-width:140px; background:#0e141c; color:var(--text);
    border:1px solid var(--edge); border-radius:8px; padding:9px 12px; font-size:15px; }
  button { appearance:none; border:1px solid var(--edge); background:#18202c; color:var(--text);
    font:inherit; font-size:13px; font-weight:550; padding:8px 13px; border-radius:8px;
    cursor:pointer; min-height:40px; }
  button:hover { background:#1e2836; }
  button:active { transform:translateY(1px); }
  button.send { background:var(--ok); border-color:var(--ok); color:#06251b; }
  .stage { flex:1; display:flex; align-items:center; justify-content:center;
    overflow:auto; padding:10px; position:relative; }
  #frame { max-width:100%; max-height:100%; border-radius:8px; border:1px solid var(--edge);
    cursor:crosshair; user-select:none; -webkit-user-select:none; touch-action:manipulation; }
  #overlay { position:absolute; inset:0; display:none; align-items:center; justify-content:center;
    flex-direction:column; gap:10px; color:var(--muted); font-family:ui-monospace,monospace;
    font-size:13px; text-align:center; padding:20px; }
  #overlay.show { display:flex; }
  footer { display:flex; gap:8px; padding:8px 12px; border-top:1px solid var(--edge);
    background:var(--panel); flex-wrap:wrap; align-items:center; font-size:11.5px; color:var(--muted); }
  footer .spacer { margin-left:auto; }
  #url { font-family:ui-monospace,monospace; max-width:46vw; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  @media (max-width:560px){ #url { max-width:80vw; } }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>Remote Chrome</h1>
  <span id="state">connecting…</span>
</header>

<div class="bar">
  <input type="text" id="typeBox" placeholder="Type text here, then press Send (goes into the page)" autocomplete="off" autocapitalize="off" />
  <button class="send" id="btnSend">Send</button>
  <button id="btnEnter" title="Enter">⏎</button>
  <button id="btnTab" title="Tab">Tab⇥</button>
  <button id="btnBksp" title="Backspace">⌫</button>
  <button id="btnEsc" title="Escape">Esc</button>
</div>

<div class="stage" id="stage">
  <img id="frame" alt="Remote Chrome live view" draggable="false" />
  <div id="overlay" class="show">
    <div id="overlayText">waiting for the remote session…</div>
    <button id="btnStart">Start Remote Chrome</button>
  </div>
</div>

<footer>
  <span id="url">—</span>
  <span class="spacer"></span>
  <span id="fps">— fps</span>
  <button id="btnReload" style="min-height:32px;font-size:12px;">Reload page</button>
  <button id="btnStop" style="min-height:32px;font-size:12px;">Close session</button>
</footer>

<script>
(function () {
  'use strict';
  // Forward ALL current query params (rtoken + XTransformPort) on every
  // request so the viewer works both directly and behind the sandbox gateway.
  var QS = window.location.search.length > 1 ? window.location.search.slice(1) : '';
  function withQs(url) {
    if (!QS) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + QS;
  }
  function api(url, opts) {
    return fetch(withQs(url), opts).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res;
    });
  }
  function post(url, body) {
    return api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  var els = {
    dot: document.getElementById('dot'),
    state: document.getElementById('state'),
    frame: document.getElementById('frame'),
    overlay: document.getElementById('overlay'),
    overlayText: document.getElementById('overlayText'),
    btnStart: document.getElementById('btnStart'),
    typeBox: document.getElementById('typeBox'),
    btnSend: document.getElementById('btnSend'),
    btnEnter: document.getElementById('btnEnter'),
    btnTab: document.getElementById('btnTab'),
    btnBksp: document.getElementById('btnBksp'),
    btnEsc: document.getElementById('btnEsc'),
    url: document.getElementById('url'),
    fps: document.getElementById('fps'),
    btnReload: document.getElementById('btnReload'),
    btnStop: document.getElementById('btnStop'),
  };

  var deviceW = 0, deviceH = 0;
  var frameTimes = [];
  var streaming = false;

  function setState(text, tone) {
    els.state.textContent = text;
    els.dot.className = 'dot' + (tone ? ' ' + tone : '');
  }
  function showOverlay(text) {
    els.overlayText.textContent = text;
    els.overlay.classList.add('show');
  }
  function hideOverlay() { els.overlay.classList.remove('show'); }

  // ── frame loop: fetch JPEG + read device size headers ──────────────
  function pullFrame() {
    if (!streaming) return;
    api('/remote/frame?t=' + Date.now())
      .then(function (res) {
        var size = res.headers.get('X-Device-Size') || '';
        var parts = size.split('x');
        if (parts.length === 2) {
          deviceW = parseInt(parts[0], 10) || 0;
          deviceH = parseInt(parts[1], 10) || 0;
        }
        return res.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var prev = els.frame.src;
        els.frame.src = url;
        if (prev && prev.indexOf('blob:') === 0) URL.revokeObjectURL(prev);
        hideOverlay();
        var now = performance.now();
        frameTimes.push(now);
        while (frameTimes.length > 0 && now - frameTimes[0] > 5000) frameTimes.shift();
        els.fps.textContent = (frameTimes.length / 5).toFixed(1) + ' fps';
        setTimeout(pullFrame, 220);
      })
      .catch(function () {
        setState('reconnecting…', 'err');
        setTimeout(function () { checkSession(); }, 1500);
      });
  }

  function checkSession() {
    api('/remote/session')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var s = data.session || {};
        if (s.running) {
          els.url.textContent = s.targetUrl || '—';
          if (!streaming) { streaming = true; pullFrame(); }
          setState('live', 'ok');
        } else {
          streaming = false;
          showOverlay('Remote Chrome is not running.');
          setState('stopped', '');
          setTimeout(checkSession, 2500);
        }
      })
      .catch(function () {
        setState('bridge unreachable', 'err');
        setTimeout(checkSession, 2500);
      });
  }

  // ── input: coordinates scaled from displayed img → device px ───────
  function toDevice(ev) {
    var r = els.frame.getBoundingClientRect();
    var sx = deviceW > 0 && r.width > 0 ? deviceW / r.width : 1;
    var sy = deviceH > 0 && r.height > 0 ? deviceH / r.height : 1;
    var cx = (ev.clientX - r.left) * sx;
    var cy = (ev.clientY - r.top) * sy;
    return {
      x: Math.max(0, Math.min(deviceW || r.width, Math.round(cx))),
      y: Math.max(0, Math.min(deviceH || r.height, Math.round(cy))),
    };
  }

  var lastTap = 0;
  els.frame.addEventListener('click', function (ev) {
    var p = toDevice(ev);
    var now = Date.now();
    var dbl = now - lastTap < 320;
    lastTap = now;
    post('/remote/input', { type: dbl ? 'dblclick' : 'click', x: p.x, y: p.y }).catch(function () {});
  });

  els.frame.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var p = toDevice(ev);
    post('/remote/input', {
      type: 'scroll',
      x: p.x,
      y: p.y,
      deltaX: Math.round(ev.deltaX),
      deltaY: Math.round(ev.deltaY),
    }).catch(function () {});
  }, { passive: false });

  // Physical keyboard → page (when the type box is NOT focused).
  var KEYMAP = { 13: 'enter', 9: 'tab', 8: 'backspace', 27: 'escape', 40: 'arrowdown', 38: 'arrowup' };
  document.addEventListener('keydown', function (ev) {
    if (ev.target === els.typeBox) return;
    var special = KEYMAP[ev.keyCode || ev.which];
    if (special) {
      ev.preventDefault();
      post('/remote/input', { type: 'key', key: special }).catch(function () {});
    } else if (ev.key && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      post('/remote/input', { type: 'text', text: ev.key }).catch(function () {});
    }
  });

  function sendTyped() {
    var t = els.typeBox.value;
    if (!t) return;
    post('/remote/input', { type: 'text', text: t })
      .then(function () { els.typeBox.value = ''; })
      .catch(function () {});
  }
  els.btnSend.addEventListener('click', sendTyped);
  els.typeBox.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); sendTyped(); }
  });
  els.btnEnter.addEventListener('click', function () { post('/remote/input', { type: 'key', key: 'enter' }).catch(function () {}); });
  els.btnTab.addEventListener('click', function () { post('/remote/input', { type: 'key', key: 'tab' }).catch(function () {}); });
  els.btnBksp.addEventListener('click', function () { post('/remote/input', { type: 'key', key: 'backspace' }).catch(function () {}); });
  els.btnEsc.addEventListener('click', function () { post('/remote/input', { type: 'key', key: 'escape' }).catch(function () {}); });

  els.btnStart.addEventListener('click', function () {
    showOverlay('starting the remote Chrome session…');
    post('/remote/start', {}).then(function () {
      setTimeout(checkSession, 500);
    }).catch(function (err) {
      showOverlay('start failed: ' + err.message);
    });
  });

  els.btnReload.addEventListener('click', function () {
    post('/remote/input', { type: 'reload' }).catch(function () {});
  });
  els.btnStop.addEventListener('click', function () {
    post('/remote/stop', {}).then(function () { streaming = false; setTimeout(checkSession, 400); }).catch(function () {});
  });

  checkSession();
})();
</script>
</body>
</html>
`;
