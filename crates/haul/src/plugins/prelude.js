// Runs before every plugin. Builds the `ctx` object handed to plugin functions on top of
// the three native functions `__host_http`, `__host_sleep` and `__host_log`.
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
      account: p.account || null,
      hasCheck: typeof p.check === 'function',
      hasCheckAccount: typeof p.checkAccount === 'function',
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
      });
    }
  };
})();
