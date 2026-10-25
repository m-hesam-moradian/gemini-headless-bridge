/* ── Gemini Headless Bridge · Test Host v0 ────────────────────────────
 * Vanilla JS, no build step. Polls the bridge API every 2s.
 *
 * Gateway passthrough: when this page is viewed through a reverse proxy that
 * routes by the ?XTransformPort=NNNN query param (e.g. the sandbox preview
 * gateway), every API call must carry the same param so it reaches the bridge
 * server instead of the default port. On a normal localhost setup the param
 * is absent and plain relative URLs are used.
 */
(function () {
  'use strict';

  var gatewayPort = new URLSearchParams(window.location.search).get('XTransformPort');

  function apiUrl(path) {
    if (!gatewayPort) return path;
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 'XTransformPort=' + encodeURIComponent(gatewayPort);
  }

  function api(path, options) {
    return fetch(apiUrl(path), options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.ok === false) {
          throw new Error((data.error && data.error.message) || 'HTTP ' + res.status);
        }
        return data;
      });
    });
  }

  function $(id) { return document.getElementById(id); }

  var els = {
    connState: $('connState'),
    brandDot: $('brandDot'),
    stateChip: $('stateChip'),
    modeVal: $('modeVal'),
    authVal: $('authVal'),
    channelVal: $('channelVal'),
    uptimeVal: $('uptimeVal'),
    profileVal: $('profileVal'),
    lastErrorRow: $('lastErrorRow'),
    lastErrorVal: $('lastErrorVal'),
    countdownRow: $('countdownRow'),
    countdownVal: $('countdownVal'),
    btnLogin: $('btnLogin'),
    btnHeadless: $('btnHeadless'),
    actionFeedback: $('actionFeedback'),
    logList: $('logList'),
    btnClearLog: $('btnClearLog'),
    btnLive: $('btnLive'),
    lvState: $('lvState'),
    lvFrame: $('lvFrame'),
    lvImg: $('lvImg'),
    lvCaption: $('lvCaption')
  };

  var MODE_LABEL = {
    stopped: 'stopped',
    headed: 'visible (login popup)',
    headless: 'headless (background)'
  };
  var AUTH_LABEL = {
    authenticated: 'authenticated',
    unauthenticated: 'not signed in',
    unknown: 'unknown'
  };

  function setChip(text, tone) {
    els.stateChip.textContent = text;
    els.stateChip.dataset.tone = tone;
    els.brandDot.dataset.tone = tone;
  }

  function overallState(s) {
    if (s.launching) return ['switching…', 'busy'];
    if (s.pendingSwitchMs > 0) {
      return ['auto-switch in ' + Math.ceil(s.pendingSwitchMs / 1000) + 's', 'busy'];
    }
    if (s.mode === 'headless' && s.authState === 'authenticated') {
      return ['authenticated & ready', 'ok'];
    }
    if (s.mode === 'headed') return ['login popup open', 'warn'];
    if (s.mode === 'headless') {
      if (s.authState === 'unauthenticated') return ['session expired — sign in again', 'err'];
      return ['headless · auth ' + s.authState, 'warn'];
    }
    return [s.hasProfile ? 'stopped · profile exists' : 'no profile yet — sign in first', 'idle'];
  }

  function fmtUptime(ms) {
    if (!ms) return '—';
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's';
  }

  function renderStatus(s) {
    var state = overallState(s);
    setChip(state[0], state[1]);

    els.modeVal.textContent = MODE_LABEL[s.mode] || s.mode;
    els.authVal.textContent = AUTH_LABEL[s.authState] || s.authState;
    els.channelVal.textContent = s.channel || '—';
    els.uptimeVal.textContent = fmtUptime(s.uptimeMs);
    els.profileVal.textContent = s.profileDir;

    els.lastErrorRow.hidden = !s.lastError;
    if (s.lastError) els.lastErrorVal.textContent = s.lastError;

    var counting = s.pendingSwitchMs > 0;
    els.countdownRow.hidden = !counting;
    if (counting) {
      els.countdownVal.textContent =
        'closing popup in ' + Math.ceil(s.pendingSwitchMs / 1000) + 's…';
    }

    els.btnLogin.disabled = !!s.launching;
    els.btnHeadless.disabled = !!s.launching;
  }

  var lastLogTs = 0;

  function appendLogs(events) {
    if (!events || !events.length) return;
    var fresh = events.filter(function (e) { return e.ts > lastLogTs; });
    if (!fresh.length) return;
    lastLogTs = fresh[fresh.length - 1].ts;

    var frag = document.createDocumentFragment();
    fresh.forEach(function (e) {
      var li = document.createElement('li');
      li.className = 'log-line ' + e.level;
      var t = document.createElement('time');
      var d = new Date(e.ts);
      var two = function (n) { return (n < 10 ? '0' : '') + n; };
      t.textContent = two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
      var span = document.createElement('span');
      span.textContent = e.msg;
      li.appendChild(t);
      li.appendChild(span);
      frag.appendChild(li);
    });
    els.logList.appendChild(frag);
    while (els.logList.children.length > 300) {
      els.logList.removeChild(els.logList.firstChild);
    }
    els.logList.scrollTop = els.logList.scrollHeight;
  }

  function poll() {
    api('/api/auth/status')
      .then(function (data) {
        els.connState.textContent = 'connected';
        els.connState.dataset.tone = 'ok';
        renderStatus(data.status);
        return api('/api/logs');
      })
      .then(function (data) {
        appendLogs(data.events);
      })
      .catch(function () {
        els.connState.textContent = 'bridge unreachable';
        els.connState.dataset.tone = 'err';
        els.brandDot.dataset.tone = 'err';
      });
  }

  function runAction(label, fn) {
    els.actionFeedback.textContent = label + '…';
    fn()
      .then(function () {
        els.actionFeedback.textContent = label + ' — done';
      })
      .catch(function (err) {
        els.actionFeedback.textContent = label + ' — error: ' + err.message;
      })
      .then(function () {
        setTimeout(function () {
          if (els.actionFeedback.textContent.indexOf(label) === 0) {
            els.actionFeedback.textContent = '';
          }
        }, 4000);
        poll();
      });
  }

  els.btnLogin.addEventListener('click', function () {
    runAction('Opening visible browser', function () {
      return api('/api/auth/login', { method: 'POST' });
    });
  });

  els.btnHeadless.addEventListener('click', function () {
    runAction('Switching to headless', function () {
      return api('/api/auth/switch-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'headless' })
      });
    });
  });

  els.btnClearLog.addEventListener('click', function () {
    els.logList.innerHTML = '';
  });

  /* ── Live view ─────────────────────────────────────────── */
  var liveTimer = null;

  function fetchLive() {
    api('/api/auth/screenshot')
      .then(function (data) {
        var s = data.shot;
        els.lvImg.src = s.image;
        els.lvFrame.classList.remove('hidden');
        var d = new Date(s.ts);
        var two = function (n) { return (n < 10 ? '0' : '') + n; };
        els.lvCaption.textContent =
          (s.mode === 'headed' ? 'visible window' : 'headless') + ' · ' + s.url + ' · ' +
          two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
        els.lvState.textContent = 'live';
        els.lvState.dataset.tone = 'ok';
      })
      .catch(function (err) {
        els.lvState.textContent = 'unavailable';
        els.lvState.dataset.tone = 'err';
        if (String(err.message).indexOf('not running') !== -1) {
          els.lvState.textContent = 'browser off';
          els.lvState.dataset.tone = 'idle';
          if (!els.lvFrame.classList.contains('hidden')) {
            els.lvCaption.textContent = 'Browser is not running — open it first.';
          }
        }
      });
  }

  els.btnLive.addEventListener('click', function () {
    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
      els.btnLive.textContent = 'Start live view';
      els.lvState.textContent = 'off';
      els.lvState.dataset.tone = 'idle';
      return;
    }
    els.btnLive.textContent = 'Stop live view';
    fetchLive();
    liveTimer = setInterval(fetchLive, 3000);
  });

  poll();
  setInterval(poll, 2000);
})();
