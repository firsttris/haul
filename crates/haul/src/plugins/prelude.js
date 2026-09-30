// Runs before every plugin. Builds the `ctx` object handed to plugin functions on top of
// the native `__host_*` functions.
(function () {
  function toHeaderMap(h) {
    var out = {};
    if (!h) return out;
    for (var k in h) if (h[k] !== undefined && h[k] !== null) out[k] = String(h[k]);
    return out;
  }

  function Response(r) {
    this.status = r.status;
    this.url = r.url;
    this.headers = r.headers;
    this.body = r.body;
    this.file = !!r.file;
  }
  Response.prototype.ok = function () { return this.status >= 200 && this.status < 300; };
  Response.prototype.text = function () { return this.body; };
  Response.prototype.json = function () { return JSON.parse(this.body); };
  Response.prototype.header = function (name) {
    var v = this.headers[String(name).toLowerCase()];
    return v === undefined ? null : v;
  };

  async function request(opts) {
    var req = {
      method: (opts.method || 'GET').toUpperCase(),
      url: String(opts.url),
      headers: toHeaderMap(opts.headers),
      followRedirects: opts.followRedirects !== false,
      timeoutMs: opts.timeoutMs || 60000,
    };
    if (opts.json !== undefined) req.json = opts.json;
    else if (opts.form !== undefined) req.form = toHeaderMap(opts.form);
    else if (opts.body !== undefined) req.body = String(opts.body);
    var r = JSON.parse(await __host_http(JSON.stringify(req)));
    if (r.error) throw new Error(r.error);
    return new Response(r);
  }

  function makeCtx(env) {
    var log = function (level) {
      return function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          parts.push(typeof a === 'string' ? a : JSON.stringify(a));
        }
        __host_log(level, parts.join(' '));
      };
    };
    var logger = log('info');
    logger.info = log('info');
    logger.warn = log('warn');
    logger.error = log('error');
    logger.debug = log('debug');
    return {
      pluginId: env.pluginId,
      http: {
        request: request,
        get: function (url, opts) {
          return request(Object.assign({}, opts || {}, { method: 'GET', url: url }));
        },
        post: function (url, body, opts) {
          var o = Object.assign({}, opts || {}, { method: 'POST', url: url });
          if (body !== undefined && body !== null) {
            if (typeof body === 'string') o.body = body;
            else o.form = body;
          }
          return request(o);
        },
      },
      wait: function (sec) { return __host_sleep(Math.max(0, Math.round(sec * 1000))); },
      log: logger,
      account: {
        get: function () { return env.account || null; },
      },
      hash: {
        sha256: function (text) { return __host_sha256(String(text)); },
      },
      crypto: {
        // AES-128 ECB/CBC decryption without padding; key, iv and data as hex.
        aesDecrypt: function (opts) {
          var r = JSON.parse(__host_aes(JSON.stringify({
            mode: String(opts.mode),
            key: String(opts.key),
            iv: opts.iv ? String(opts.iv) : undefined,
            data: String(opts.data),
          })));
          if (r.error) throw new Error('aesDecrypt: ' + r.error);
          return r.data;
        },
        // Heavier operations in the core (plugins/crypto.rs); resolves to hex.
        run: async function (op, args) {
          var r = JSON.parse(await __host_crypto(String(op), JSON.stringify(args || {})));
          if (r.error) throw new Error('crypto ' + op + ': ' + r.error);
          return r.data;
        },
      },
      captcha: {
        // Waits until the user solved it in the browser (see captcha.rs); returns the token.
        solve: async function (req) {
          var r = JSON.parse(await __host_captcha(JSON.stringify({
            kind: String(req.kind),
            siteKey: req.siteKey ? String(req.siteKey) : '',
            pageUrl: String(req.pageUrl),
            enterprise: !!req.enterprise,
            imageUrl: req.imageUrl ? String(req.imageUrl) : undefined,
            headers: toHeaderMap(req.headers),
          })));
          if (r.token) return r.token;
          var e = new Error(r.error === 'cancelled'
            ? '\u0002Captcha abgebrochen\u001fCaptcha cancelled\u0003'
            : r.error === 'timeout'
              ? '\u0002Captcha nicht rechtzeitig gelöst\u001fCaptcha not solved in time\u0003'
              : 'Captcha: ' + r.error);
          // Cancelled by the user: stop. Not solved in time: try again later, the user may be away.
          e.haulKind = r.error === 'cancelled' ? 'fatal' : 'temporary';
          if (r.error === 'timeout') e.haulWait = 30 * 60;
          throw e;
        },
      },
      password: {
        // The saved download password, else the user is asked in the UI. `wrong`: the hoster
        // rejected the last one; it is forgotten and the user asked again.
        get: async function (opts) {
          var r = JSON.parse(await __host_password(opts && opts.wrong ? 'wrong' : 'get'));
          if (typeof r.password === 'string') return r.password;
          var e = new Error(r.error === 'cancelled'
            ? '\u0002Passwort-Eingabe abgebrochen\u001fPassword entry cancelled\u0003'
            : r.error === 'timeout'
              ? '\u0002Passwort nicht rechtzeitig eingegeben\u001fPassword not entered in time\u0003'
              : '\u0002Datei ist passwortgeschützt\u001fThe file is password protected\u0003');
          // JD: a cancelled password dialog is fatal. Not answered in time: ask again later.
          e.haulKind = r.error === 'timeout' ? 'temporary' : 'fatal';
          if (r.error === 'timeout') e.haulWait = 30 * 60;
          throw e;
        },
        // Drops a rejected password without asking for another one.
        forget: async function () { await __host_password('forget'); },
        // The saved password or null; never asks.
        saved: async function () {
          var r = JSON.parse(await __host_password('saved'));
          return typeof r.password === 'string' ? r.password : null;
        },
      },
      cookies: {
        get: function (url) { return __host_cookies(String(url)); },
        set: function (url, cookie) { __host_set_cookie(String(url), String(cookie)); },
      },
    };
  }

  globalThis.__haul_meta = function () {
    var p = globalThis.__plugin && (globalThis.__plugin.default || globalThis.__plugin);
    if (!p || typeof p !== 'object') throw new Error('plugin has no default export');
    return JSON.stringify({
      id: p.id,
      name: p.name || p.id,
      version: p.version || 0,
      matches: (p.matches || []).map(function (r) {
        return typeof r === 'string' ? { source: r, flags: '' } : { source: r.source, flags: r.flags };
      }),
      accountRequired: !!p.accountRequired,
      serial: !!p.serial,
      crawlWithAccount: !!p.crawlWithAccount,
      account: p.account || null,
      hasCheck: typeof p.check === 'function',
      hasCheckAccount: typeof p.checkAccount === 'function',
      hasCrawl: typeof p.crawl === 'function',
    });
  };

  globalThis.__haul_invoke = async function (method, argsJson, envJson) {
    try {
      var p = globalThis.__plugin.default || globalThis.__plugin;
      var ctx = makeCtx(JSON.parse(envJson));
      var args = JSON.parse(argsJson);
      if (typeof p[method] !== 'function') throw new Error('plugin does not implement ' + method);
      var value = await p[method].apply(p, args.concat([ctx]));
      return JSON.stringify({ ok: true, value: value === undefined ? null : value });
    } catch (e) {
      return JSON.stringify({
        ok: false,
        kind: (e && e.haulKind) || 'fatal',
        message: String((e && e.message) || e),
        wait: (e && typeof e.haulWait === 'number' && e.haulWait > 0) ? e.haulWait : undefined,
        scope: (e && e.haulScope === 'hoster') ? 'hoster' : undefined,
      });
    }
  };
})();
