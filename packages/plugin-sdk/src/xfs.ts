/**
 * Reusable base for XFileSharing-Pro hosters (ddownload and many others), modeled on
 * JDownloader's `XFileSharingProBasic` and pyLoad's `XFSAccount`. A concrete plugin passes
 * its domains and, where the site deviates, overrides individual patterns.
 *
 * Account modes, picked from what the user entered:
 *  - Session cookie: secret `xfss=…` (or user left empty when the site has no user API).
 *    For sites whose login form is protected by a captcha (Cloudflare Turnstile): log in
 *    once in the browser and hand Haul the session cookie.
 *  - Web login: user + password → cookie session.
 *  - API key: user left empty (or "apikey"), secret = API key → XFS JSON API
 *    (only when the site hands out user API keys, see `userApiKeys`).
 */
import {
  AccountError,
  AccountInfo,
  CheckResult,
  Ctx,
  HttpOptions,
  HttpResponse,
  OfflineError,
  PluginDefinition,
  Resolved,
  TemporaryError,
  match,
  parseForms,
  parseSize,
  resolveUrl,
} from './index';

export interface XfsConfig {
  id: string;
  name: string;
  version: number | string;
  /** Main domain first; used to build URLs. */
  domains: string[];
  /** Length of the file id in URLs (XFS default: 12). */
  fileIdLength?: number;
  /** Base of the JSON API, e.g. `https://example.com/api`. */
  apiBase?: string;
  /** Whether users can get their own API key (enables the API-key account mode). */
  userApiKeys?: boolean;
  accountRequired?: boolean;
  maxConnections?: number;
  offlinePatterns?: RegExp[];
  namePatterns?: RegExp[];
  sizePatterns?: RegExp[];
  directLinkPatterns?: RegExp[];
  loginPath?: string;
  /** Marks a premium account on `?op=my_account`. Without it, premium = expiry in the future. */
  premiumPattern?: RegExp;
  /** First group: expiry date, e.g. `12 October 2026` or `2026-10-12`. */
  validUntilPatterns?: RegExp[];
  /** Traffic left in bytes from the `?op=my_account` HTML. */
  trafficLeft?: (html: string) => number | undefined;
}

const DEFAULT_OFFLINE = [
  />\s*File Not Found\s*</i,
  />\s*File Deleted\s*</i,
  /No such file/i,
  /The file (?:was|has been) (?:removed|deleted)/i,
  /file was deleted by/i,
  /Reason for deletion/i,
];

const DEFAULT_NAMES = [
  /class=["']file-info-name["'][^>]*>([^<]+)</i,
  /<input[^>]+name=["']fname["'][^>]+value=["']([^"']+)["']/i,
  /<div class=["'][^"']*name[^"']*["'][^>]*>\s*<h\d[^>]*>([^<]+)</i,
  /<h1[^>]*class=["'][^"']*file[^"']*["'][^>]*>([^<]+)</i,
  /<title>\s*Download\s+([^<]+?)\s*<\/title>/i,
];

const DEFAULT_SIZES = [
  /<span[^>]+class=["'][^"']*file-size[^"']*["'][^>]*>([^<]+)</i,
  /\(\s*([\d.,]+\s*(?:B|KB|MB|GB|TB))\s*\)/i,
  /Size\s*:?\s*<[^>]*>\s*([\d.,]+\s*(?:B|KB|MB|GB|TB))/i,
];

const DEFAULT_DIRECT = [
  /href=["'](https?:\/\/[^"']+\/d\/[^"']+)["']/i,
  /href=["'](https?:\/\/[^"']+\/files\/[^"']+)["']/i,
  /["'](https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\/d\/[^"']+)["']/i,
];

const DEFAULT_VALID_UNTIL = [
  /Premium(?:[- ]Account)?\s*expires?:?\s*(?:<[^>]+>\s*)*([^<]+)/i,
  /Premium until:?\s*(?:<[^>]+>\s*)*([^<]+)/i,
  />\s*Active until\s+([^<]+?)\s*</i,
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** `2026-10-12`, `12 October 2026`, `October 12, 2026` → Unix ms (UTC midnight). */
export function parseDate(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const month = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  const dmy = /(\d{1,2})\.?\s+([A-Za-z]+)\.?,?\s+(\d{4})/.exec(text);
  if (dmy && month(dmy[2]) >= 0) return Date.UTC(+dmy[3], month(dmy[2]), +dmy[1]);
  const mdy = /([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (mdy && month(mdy[1]) >= 0) return Date.UTC(+mdy[3], month(mdy[1]), +mdy[2]);
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isApiAccount(user: string): boolean {
  return user.trim() === '' || user.trim().toLowerCase() === 'apikey';
}

type Mode =
  | { kind: 'cookie'; cookie: string }
  | { kind: 'api'; key: string }
  | { kind: 'password'; user: string; password: string };

const CAPTCHA_WORDS = /cf-turnstile|g-recaptcha|h-captcha|captcha/i;

export function createXfsPlugin(cfg: XfsConfig): PluginDefinition {
  const idLen = cfg.fileIdLength ?? 12;
  const host = cfg.domains[0];
  const base = `https://${host}`;
  const domainRe = cfg.domains.map(escapeRe).join('|');
  const linkRe = new RegExp(`https?:\\/\\/(?:www\\.)?(?:${domainRe})\\/(?:d\\/)?([a-z0-9]{${idLen}})`, 'i');
  const offline = cfg.offlinePatterns ?? DEFAULT_OFFLINE;
  const names = cfg.namePatterns ?? DEFAULT_NAMES;
  const sizes = cfg.sizePatterns ?? DEFAULT_SIZES;
  const directs = cfg.directLinkPatterns ?? DEFAULT_DIRECT;
  const userApi = !!(cfg.apiBase && cfg.userApiKeys);

  const cookieHelp =
    `Im Browser bei ${host} anmelden, dann das Cookie „xfss“ kopieren ` +
    `(Entwicklertools → Anwendung/Speicher → Cookies → ${host}) und im Account als Passwort ` +
    `„xfss=…“ eintragen.`;

  const fileId = (link: string): string => {
    const m = linkRe.exec(link);
    if (!m) throw new OfflineError('Link hat kein gültiges Dateikennzeichen');
    return m[1].toLowerCase();
  };
  const fileUrl = (link: string) => `${base}/${fileId(link)}`;

  function mode(user: string, secret: string): Mode {
    const s = secret.trim();
    if (/(?:^|;\s*)xfss=/i.test(s)) return { kind: 'cookie', cookie: s };
    if (isApiAccount(user)) {
      if (userApi) return { kind: 'api', key: s };
      // No user API: an empty user means the secret is the bare cookie value.
      return { kind: 'cookie', cookie: s.includes('=') ? s : `xfss=${s}` };
    }
    return { kind: 'password', user: user.trim(), password: secret };
  }

  /** Web requests; in cookie mode the session cookie is sent explicitly. */
  function web(ctx: Ctx, m: Mode | null) {
    const withCookie = (opts?: HttpOptions): HttpOptions | undefined => {
      if (!m || m.kind !== 'cookie') return opts;
      const cookie = /(?:^|;\s*)lang=/.test(m.cookie) ? m.cookie : `${m.cookie}; lang=english`;
      return { ...opts, headers: { ...(opts?.headers ?? {}), Cookie: cookie } };
    };
    return {
      get: (url: string, opts?: HttpOptions) => ctx.http.get(url, withCookie(opts)),
      post: (url: string, body: Record<string, string>, opts?: HttpOptions) => ctx.http.post(url, body, withCookie(opts)),
    };
  }

  function assertOnline(res: HttpResponse) {
    if (res.status === 404 || offline.some((p) => p.test(res.body))) throw new OfflineError();
    if (res.status >= 500) throw new TemporaryError(`${cfg.name}: HTTP ${res.status}`);
  }

  function isDirect(res: HttpResponse): string | null {
    const loc = res.header('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      const abs = resolveUrl(res.url, loc);
      // A redirect back to the file page or login is not a download.
      if (!linkRe.test(abs) && !/login|op=/.test(abs)) return abs;
    }
    return null;
  }

  // ---- API mode --------------------------------------------------------------------

  async function api<T>(ctx: Ctx, path: string, params: Record<string, string>): Promise<T> {
    const qs = Object.keys(params)
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&');
    const res = await ctx.http.get(`${cfg.apiBase}${path}?${qs}`);
    let data: { status?: number; msg?: string; result?: unknown };
    try {
      data = res.json();
    } catch {
      throw new TemporaryError(`${cfg.name}-API: unerwartete Antwort (HTTP ${res.status})`);
    }
    if (data.status === 403 || /invalid key|wrong key/i.test(data.msg || '')) {
      throw new AccountError(`${cfg.name}-API: ungültiger API-Key`);
    }
    if (data.status === 404) throw new OfflineError();
    if (data.status !== 200) throw new TemporaryError(`${cfg.name}-API: ${data.msg || data.status}`);
    return data.result as T;
  }

  // ---- web session -----------------------------------------------------------------

  async function accountPage(ctx: Ctx, m: Mode): Promise<HttpResponse | null> {
    // Follow redirects: some sites move the account page; logged out ends on the login form.
    const res = await web(ctx, m).get(`${base}/?op=my_account`);
    return res.status === 200 && /op=logout|\/logout/i.test(res.body) ? res : null;
  }

  /** Makes sure the session is logged in and returns the account page. */
  async function session(ctx: Ctx, m: Mode): Promise<HttpResponse> {
    const existing = await accountPage(ctx, m);
    if (existing) return existing;
    if (m.kind === 'cookie') {
      throw new AccountError(`${cfg.name}: Sitzungs-Cookie ungültig oder abgelaufen. ${cookieHelp}`);
    }
    if (m.kind !== 'password') throw new AccountError(`${cfg.name}: keine Web-Anmeldung möglich`);

    const loginUrl = `${base}${cfg.loginPath ?? '/login.html'}`;
    const page = await ctx.http.get(loginUrl);
    const forms = parseForms(page.body);
    const form =
      forms.find((f) => /name=["']FL["']/i.test(f.html)) ??
      forms.find((f) => f.fields.op === 'login' || 'password' in f.fields);
    const fields = { ...(form?.fields ?? {}), op: 'login', redirect: base, login: m.user, password: m.password };
    const action = form?.action ? resolveUrl(loginUrl, form.action) : loginUrl;
    const res = await ctx.http.post(action, fields);

    const after = await accountPage(ctx, m);
    if (after) return after;
    if (/Incorrect Login or Password/i.test(res.body)) {
      throw new AccountError(`${cfg.name}: Benutzername oder Passwort falsch`);
    }
    if (/account (?:was|has been) banned/i.test(res.body)) throw new AccountError(`${cfg.name}: Account gesperrt`);
    if (CAPTCHA_WORDS.test(form?.html ?? page.body)) {
      throw new AccountError(`${cfg.name} verlangt beim Login ein Captcha, das Haul nicht lösen kann. ${cookieHelp}`);
    }
    throw new AccountError(`${cfg.name}: Login fehlgeschlagen`);
  }

  function accountInfo(html: string): AccountInfo {
    const validUntil = parseDate(match(html, ...(cfg.validUntilPatterns ?? DEFAULT_VALID_UNTIL)));
    let trafficLeft: number | undefined;
    if (cfg.trafficLeft) {
      trafficLeft = cfg.trafficLeft(html);
    } else {
      const t = match(html, /Traffic available(?: today)?:?\s*(?:<[^>]+>\s*)*([^<]+)/i);
      trafficLeft = t && !/unlimited/i.test(t) ? parseSize(t) : undefined;
    }
    const premium = cfg.premiumPattern
      ? cfg.premiumPattern.test(html)
      : validUntil !== undefined
        ? validUntil > Date.now()
        : undefined;
    return {
      valid: true,
      premium,
      trafficLeft,
      validUntil,
      message: premium === false ? 'Account ist nicht Premium' : undefined,
    };
  }

  function currentMode(ctx: Ctx): Mode {
    const acc = ctx.account.get();
    if (!acc) throw new AccountError(`${cfg.name}: kein Premium-Account hinterlegt`);
    return mode(acc.user, acc.secret);
  }

  return {
    id: cfg.id,
    name: cfg.name,
    version: cfg.version,
    matches: [linkRe],
    accountRequired: cfg.accountRequired ?? true,
    account: {
      userLabel: 'Benutzer',
      secretLabel: userApi ? 'Passwort, API-Key oder xfss-Cookie' : 'Passwort oder xfss-Cookie',
      help:
        `Benutzer und Passwort wie in JDownloader. Verlangt ${host} beim Login ein Captcha, ` +
        `einmal im Browser anmelden und das Cookie „xfss“ als Passwort „xfss=…“ eintragen.` +
        (userApi ? ' Mit leerem Benutzer wird das Passwortfeld als API-Key verwendet.' : ''),
    },

    async check(link, ctx): Promise<CheckResult> {
      const acc = ctx.account.get();
      const m = acc ? mode(acc.user, acc.secret) : null;
      if (m?.kind === 'api') {
        const list = await api<Array<{ status: number; name?: string; size?: number | string }>>(ctx, '/file/info', {
          key: m.key,
          file_code: fileId(link),
        });
        const f = Array.isArray(list) ? list[0] : undefined;
        if (!f || f.status !== 200) return { online: false };
        return { online: true, name: f.name, size: f.size !== undefined ? Number(f.size) : undefined };
      }
      const res = await web(ctx, m?.kind === 'cookie' ? m : null).get(fileUrl(link));
      if (res.status === 404 || offline.some((p) => p.test(res.body))) return { online: false };
      return { online: true, name: match(res.body, ...names), size: parseSize(match(res.body, ...sizes)) };
    },

    async resolve(link, ctx): Promise<Resolved> {
      const m = currentMode(ctx);
      const id = fileId(link);

      if (m.kind === 'api') {
        const r = await api<{ url?: string; size?: number | string; name?: string }>(ctx, '/file/direct_link', {
          key: m.key,
          file_code: id,
        });
        if (!r || !r.url) throw new TemporaryError(`${cfg.name}-API lieferte keinen Direktlink`);
        return { url: r.url, name: r.name, size: r.size !== undefined ? Number(r.size) : undefined, maxConnections: cfg.maxConnections };
      }

      await session(ctx, m);
      const http = web(ctx, m);
      const url = fileUrl(link);
      // With "direct downloads" enabled in the account, the file page redirects right away.
      const page = await http.get(url, { followRedirects: false });
      const direct = isDirect(page);
      if (direct) return { url: direct, maxConnections: cfg.maxConnections };
      assertOnline(page);

      const form = parseForms(page.body).find((f) => f.fields.op === 'download2' || f.fields.op === 'download1');
      if (!form) {
        const inline = match(page.body, ...directs);
        if (inline) return { url: inline, maxConnections: cfg.maxConnections };
        if (/premium only|only premium|upgrade your account/i.test(page.body)) {
          throw new AccountError(`${cfg.name}: Account ist nicht Premium`);
        }
        throw new TemporaryError(`${cfg.name}: Download-Formular nicht gefunden`);
      }
      const fields: Record<string, string> = { ...form.fields, op: 'download2', id, referer: '' };
      delete fields.method_free;
      fields.method_premium = fields.method_premium || '1';
      const post = await http.post(form.action ? resolveUrl(url, form.action) : url, fields, { followRedirects: false });
      const redirected = isDirect(post);
      if (redirected) return { url: redirected, maxConnections: cfg.maxConnections };
      assertOnline(post);
      const found = match(post.body, ...directs);
      if (found) return { url: found, maxConnections: cfg.maxConnections };
      if (/traffic|bandwidth limit|exceeded/i.test(post.body)) {
        throw new AccountError(`${cfg.name}: Traffic aufgebraucht`);
      }
      throw new TemporaryError(`${cfg.name}: Direktlink nicht gefunden`);
    },

    async checkAccount(ctx): Promise<AccountInfo> {
      const m = currentMode(ctx);
      if (m.kind === 'api') {
        const info = await api<{ premium_expire?: string; traffic_left?: number | string; premium?: number | boolean }>(
          ctx,
          '/account/info',
          { key: m.key },
        );
        const validUntil = parseDate(info?.premium_expire);
        const traffic = info?.traffic_left;
        return {
          valid: true,
          premium: validUntil ? validUntil > Date.now() : !!info?.premium,
          trafficLeft: traffic === undefined ? undefined : typeof traffic === 'number' ? traffic * 1024 * 1024 : parseSize(String(traffic)),
          validUntil,
        };
      }
      const page = await session(ctx, m);
      return accountInfo(page.body);
    },
  };
}
