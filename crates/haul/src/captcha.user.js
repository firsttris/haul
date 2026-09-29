// ==UserScript==
// @name         Haul Captcha
// @namespace    https://github.com/firsttris/haul
// @version      1
// @description  Solves captchas for Haul on the hoster's own page, like JDownloader's browser solver.
// @match        *://*/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      *
// @noframes
// ==/UserScript==
//
// Haul opens the hoster page with the challenge after "#haul-captcha=…". The fragment never
// reaches the hoster. Only then this script replaces the page with the captcha widget; the
// token is valid because the widget runs on the hoster's domain. The token goes back to Haul
// with the challenge's one-time secret. GM_xmlhttpRequest, because a https page may not call
// a http server in the home network itself.
(function () {
  'use strict';
  if (!/[#&]haul-captcha=/.test(location.hash)) return;
  var p = {};
  location.hash.slice(1).split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i > 0) p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  });
  var de = (p.lang || navigator.language || '').toLowerCase().indexOf('de') === 0;
  var T = de
    ? { title: 'Captcha für Haul', solve: 'Captcha lösen', sending: 'Wird an Haul geschickt …', done: 'Gelöst. Haul lädt weiter, dieser Tab kann zu.', failed: 'Haul hat die Antwort nicht angenommen (Captcha abgelaufen oder schon gelöst?).', unreachable: 'Haul ist nicht erreichbar: ' }
    : { title: 'Captcha for Haul', solve: 'Solve the captcha', sending: 'Sending to Haul …', done: 'Solved. Haul continues, you can close this tab.', failed: 'Haul did not accept the answer (captcha expired or already solved?).', unreachable: 'Haul is not reachable: ' };
  var widgets = {
    recaptcha: {
      src: (p.enterprise === '1' ? 'https://www.google.com/recaptcha/enterprise.js' : 'https://www.google.com/recaptcha/api.js') + '?hl=' + (de ? 'de' : 'en'),
      cls: 'g-recaptcha',
      field: 'g-recaptcha-response',
    },
    hcaptcha: { src: 'https://js.hcaptcha.com/1/api.js?hl=' + (de ? 'de' : 'en'), cls: 'h-captcha', field: 'h-captcha-response' },
    turnstile: { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js', cls: 'cf-turnstile', field: 'cf-turnstile-response' },
  };
  var w = widgets[p.kind];
  if (!w || !p.sitekey || !p.server) return;

  try {
    window.stop();
  } catch (e) {
    /* already loaded */
  }
  var root = document.documentElement || document.appendChild(document.createElement('html'));
  root.innerHTML =
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title></title></head>' +
    '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1113;color:#e7e9ec;font:15px system-ui,sans-serif">' +
    '<div style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:20px;margin:0 0 6px"></h1>' +
    '<p id="haul-host" style="color:#9aa1ab;margin:0 0 18px"></p><div id="haul-widget" style="display:inline-block"></div>' +
    '<p id="haul-status" style="margin:18px 0 0;color:#f0a43a"></p></div></body>';
  document.title = T.title;
  document.querySelector('h1').textContent = T.solve;
  document.getElementById('haul-host').textContent = location.hostname;
  var status = document.getElementById('haul-status');
  var box = document.createElement('div');
  box.className = w.cls;
  box.setAttribute('data-sitekey', p.sitekey);
  document.getElementById('haul-widget').appendChild(box);
  var script = document.createElement('script');
  script.src = w.src;
  script.async = true;
  document.head.appendChild(script);

  function send(token) {
    status.textContent = T.sending;
    var body = JSON.stringify({ id: p['haul-captcha'], secret: p.secret, token: token });
    var url = p.server.replace(/\/+$/, '') + '/api/captcha/solve';
    var done = function (code, err) {
      if (code === 204) {
        status.style.color = '#6fcf97';
        status.textContent = T.done;
        setTimeout(function () {
          window.close();
        }, 1500);
      } else {
        status.style.color = '#f07a6a';
        status.textContent = err ? T.unreachable + err : T.failed;
      }
    };
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST',
        url: url,
        headers: { 'Content-Type': 'application/json' },
        data: body,
        onload: function (r) {
          done(r.status);
        },
        onerror: function () {
          done(0, url);
        },
      });
    } else {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
        .then(function (r) {
          done(r.status);
        })
        .catch(function (e) {
          done(0, String(e));
        });
    }
  }

  // The widget writes its answer into a form field; watch it instead of a page-world callback,
  // which a sandboxed userscript cannot pass to the widget.
  var sent = false;
  var timer = setInterval(function () {
    var fields = document.getElementsByName(w.field);
    for (var i = 0; i < fields.length; i++) {
      if (!sent && fields[i].value) {
        sent = true;
        clearInterval(timer);
        send(fields[i].value);
      }
    }
  }, 400);
})();
