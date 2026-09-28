/**
 * Reusable base for XFileSharing-Pro hosters (ddownload and many others), modeled on
 * JDownloader's `XFileSharingProBasic`. A concrete plugin passes its domains and, where the
 * site deviates, overrides individual patterns.
 *
 * Two account modes:
 *  - API key: account user left empty (or "apikey"), secret = API key → XFS JSON API.
 *  - Web login: user + password → cookie session, direct link via the premium page.
 */
import {
  AccountError,
  AccountInfo,
  CheckResult,
  Ctx,
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
  accountRequired?: boolean;
  maxConnections?: number;
  offlinePatterns?: RegExp[];
  namePatterns?: RegExp[];
  sizePatterns?: RegExp[];
  directLinkPatterns?: RegExp[];
  loginPath?: string;
}

const DEFAULT_OFFLINE = [
  /File Not Found/i,
  /No such file/i,
  /The file (?:was|has been) (?:removed|deleted)/i,
  /file was deleted by/i,
  /Reason for deletion/i,
  /<b>File Not Found<\/b>/i,
];

const DEFAULT_NAMES = [
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isApiAccount(user: string): boolean {
  return user.trim() === '' || user.trim().toLowerCase() === 'apikey';
}

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

  const fileId = (link: string): string => {
    const m = linkRe.exec(link);
    if (!m) throw new OfflineError('Link hat kein gültiges Dateikennzeichen');
    return m[1].toLowerCase();
  };
  const fileUrl = (link: string) => `${base}/${fileId(link)}`;

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
    if (!cfg.apiBase) throw new AccountError(`${cfg.name} hat keine API; bitte Benutzer und Passwort angeben`);
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

  // ---- web mode --------------------------------------------------------------------

  async function isLoggedIn(ctx: Ctx): Promise<boolean> {
    const res = await ctx.http.get(`${base}/?op=my_account`, { followRedirects: false });
    return res.status === 200 && /op=logout|\/logout/i.test(res.body);
  }

  async function login(ctx: Ctx, user: string, password: string): Promise<void> {
    if (await isLoggedIn(ctx)) return;
    const loginUrl = `${base}${cfg.loginPath ?? '/login.html'}`;
    const page = await ctx.http.get(loginUrl);
    const form = parseForms(page.body).find((f) => f.fields.op === 'login' || 'password' in f.fields);
    if (form && /captcha|g-recaptcha|h-captcha|cf-turnstile/i.test(form.html)) {
      throw new AccountError(`${cfg.name}-Login verlangt ein Captcha; bitte API-Key verwenden`);
    }
    const fields = { ...(form?.fields ?? {}), op: 'login', redirect: '', login: user, password };
    const action = form?.action ? resolveUrl(loginUrl, form.action) : base + '/';
    await ctx.http.post(action, fields);
    if (!(await isLoggedIn(ctx))) throw new AccountError(`${cfg.name}: Login fehlgeschlagen`);
  }

  function parseDate(text: string | undefined): number | undefined {
    if (!text) return undefined;
    const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
    const t = Date.parse(text.replace(/,/g, ''));
    return isNaN(t) ? undefined : t;
  }

  return {
    id: cfg.id,
    name: cfg.name,
    version: cfg.version,
    matches: [linkRe],
    accountRequired: cfg.accountRequired ?? true,

    async check(link, ctx): Promise<CheckResult> {
      const acc = ctx.account.get();
      if (acc && isApiAccount(acc.user) && cfg.apiBase) {
        const list = await api<Array<{ status: number; name?: string; size?: number | string }>>(ctx, '/file/info', {
          key: acc.secret,
          file_code: fileId(link),
        });
        const f = Array.isArray(list) ? list[0] : undefined;
        if (!f || f.status !== 200) return { online: false };
        return { online: true, name: f.name, size: f.size !== undefined ? Number(f.size) : undefined };
      }
      const res = await ctx.http.get(fileUrl(link));
      if (res.status === 404 || offline.some((p) => p.test(res.body))) return { online: false };
      return { online: true, name: match(res.body, ...names), size: parseSize(match(res.body, ...sizes)) };
    },

    async resolve(link, ctx): Promise<Resolved> {
      const acc = ctx.account.get();
      if (!acc) throw new AccountError(`${cfg.name}: kein Premium-Account hinterlegt`);
      const id = fileId(link);

      if (isApiAccount(acc.user)) {
        const r = await api<{ url?: string; size?: number | string; name?: string }>(ctx, '/file/direct_link', {
          key: acc.secret,
          file_code: id,
        });
        if (!r || !r.url) throw new TemporaryError(`${cfg.name}-API lieferte keinen Direktlink`);
        return { url: r.url, name: r.name, size: r.size !== undefined ? Number(r.size) : undefined, maxConnections: cfg.maxConnections };
      }

      await login(ctx, acc.user, acc.secret);
      const url = fileUrl(link);
      // With "direct downloads" enabled in the account, the file page redirects right away.
      const page = await ctx.http.get(url, { followRedirects: false });
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
      const post = await ctx.http.post(form.action ? resolveUrl(url, form.action) : url, fields, { followRedirects: false });
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
      const acc = ctx.account.get();
      if (!acc) return { valid: false, message: 'kein Account' };
      if (isApiAccount(acc.user)) {
        const info = await api<{ premium_expire?: string; traffic_left?: number | string; premium?: number | boolean }>(
          ctx,
          '/account/info',
          { key: acc.secret },
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
      await login(ctx, acc.user, acc.secret);
      const page = await ctx.http.get(`${base}/?op=my_account`);
      const expire = match(
        page.body,
        /Premium(?:[- ]Account)?\s*expires?:?\s*(?:<[^>]+>\s*)*([^<]+)/i,
        /Premium until:?\s*(?:<[^>]+>\s*)*([^<]+)/i,
      );
      const traffic = match(page.body, /Traffic available(?: today)?:?\s*(?:<[^>]+>\s*)*([^<]+)/i);
      const validUntil = parseDate(expire);
      return {
        valid: true,
        premium: validUntil !== undefined ? validUntil > Date.now() : undefined,
        trafficLeft: traffic && !/unlimited/i.test(traffic) ? parseSize(traffic) : undefined,
        validUntil,
      };
    },
  };
}
