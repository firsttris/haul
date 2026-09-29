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
 *
 * Without an account, sites with `free: true` go JD's free way (`doFree`): the download1 form
 * with `method_free`, the countdown, the plain-text captcha if any, then download2.
 */
import {
  AccountError,
  AccountInfo,
  Bilingual,
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
  bilingual,
  CAPTCHA_FIELD,
  decodeHtml,
  findCaptcha,
  HosterLimitError,
  PluginError,
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
  /** Extra hosts that serve the final files (CDNs), besides `domains` and their subdomains. */
  downloadHosts?: string[];
  loginPath?: string;
  /** Marks a premium account on `?op=my_account`. Without it, premium = expiry in the future. */
  premiumPattern?: RegExp;
  /** First group: expiry date, e.g. `12 October 2026` or `2026-10-12`. */
  validUntilPatterns?: RegExp[];
  /** Traffic left in bytes from the `?op=my_account` HTML. */
  trafficLeft?: (html: string) => number | undefined;
  /** Free downloads without an account (JD's doFree). */
  free?: boolean;
  /** Connections per file for free downloads (JD: getMaxChunks without account; default 1). */
  freeMaxConnections?: number;
  /** Site-specific errors on the way (JD: a plugin's own checkErrors); throw to stop. */
  checkErrors?: (html: string, res: HttpResponse) => void;
  /** Headers for every request to the site, e.g. a Referer against simple hotlink protection. */
  headers?: Record<string, string>;
  /** Where a site's free pages differ from the XFS default (JD: overridden find* methods). */
  freeHooks?: FreeHooks;
}

/** A form to post in the free flow. `html` is searched for captchas. */
export interface FreeStep {
  fields: Record<string, string>;
  action?: string;
  html: string;
}

export interface FreeHooks {
  /** JD findFormDownload1Free. */
  download1?: (page: HttpResponse) => FreeStep | undefined;
  /** JD findFormDownload2Free; gets the form the default found, if any. */
  download2?: (page: HttpResponse, fileId: string, found: FreeStep | undefined) => FreeStep | undefined;
  /** JD regexWaittime, in seconds. */
  countdown?: (html: string) => number | undefined;
  /** JD getDllink, e.g. a JSON answer. */
  directLink?: (res: HttpResponse) => string | undefined;
}

/** JD's isOffline (XFileSharingProBasic, mirror 2026-09-28) plus a few older variants. */
const DEFAULT_OFFLINE = [
  />\s*(?:[*-]\s*)?File Not Found\s*</i,
  />\s*This file was banned by copyright/i,
  />\s*(?:[*-]\s*)?File Deleted\s*</i,
  /No such file/i,
  /The file (?:was|has been) (?:removed|deleted)/i,
  /file was deleted by/i,
  /Reason for deletion/i,
  />\s*(?:[*-]\s*)?File has been removed due to copyright issues\s*</i,
  />\s*(?:[*-]\s*)?The file expired/i,
  />\s*(?:[*-]\s*)?Sorry, we can't find the page you're looking for/i,
  />\s*(?:[*-]\s*)?File could not be found due to expiration or removal by the file owner/i,
  />\s*(?:[*-]\s*)?The file of the above link no longer exists/i,
  />\s*(?:[*-]\s*)?The file you were looking for doesn/i,
  />\s*(?:[*-]\s*)?File is not? longer available as it/i,
];

/** JD's getPremiumOnlyErrorMessage texts. */
const PREMIUM_ONLY = [
  /\s*(?:The file you requested reached max downloads|This file reached max downloads)[^<]*/i,
  /\s*(?:Available Only for Premium Members|File is available only for Premium users|Please Buy Premium To download)[^<]*/i,
  /\s*(?:This file is not available for free download|Only Premium user can download this file)[^<]*/i,
  /\s*This (?:video|file) is available for Premium Users only[^<]*/i,
  /(?:\s*Sorry\s*,)?\s*This file (?:can|only can|can only) be downloaded by[^<]+/i,
  /\s*You can download files up to \d+ [^<]*/i,
];

/** Seconds from "1 hour 5 minutes 3 seconds" (JD: preciseWaittime); default one hour. */
export function parseWait(text: string): number {
  const n = (unit: string) => Number(new RegExp(`(\\d+)\\s*${unit}`, 'i').exec(text)?.[1] ?? 0);
  const total = n('days?') * 86400 + n('hours?') * 3600 + n('minutes?') * 60 + n('seconds?');
  return total > 0 ? total + 1 : 3600;
}

/** Countdown seconds on a free download page (JD: regexWaittime). */
export function countdown(html: string): number | undefined {
  const m =
    /id=["']countdown_str["'][^>]*>[^<>]*<span id=[^>]*>\s*(\d+)\s*<\/span>/i.exec(html) ??
    /class="seconds"[^>]*>\s*(\d+)\s*</i.exec(html) ??
    /id="seconds"[^>]*>\s*(\d+)\s*</i.exec(html);
  return m ? Number(m[1]) : undefined;
}

/**
 * JD's "plaintext captcha" (ManiacMansion): digits as HTML entities in absolutely positioned
 * spans; ordered by `padding-left` they are the code.
 */
export function plainTextCaptcha(html: string): string | undefined {
  const re = /<span style=.position:absolute;padding-left:(\d+)px;padding-top:\d+px;.>(&#\d+;)<\/span>/gi;
  const digits = [...html.matchAll(re)].map((m) => [Number(m[1]), decodeHtml(m[2])] as const);
  if (!digits.length) return undefined;
  return digits
    .sort((a, b) => a[0] - b[0])
    .map((d) => d[1])
    .join('');
}

const DEFAULT_NAMES = [
  /class=["']file-info-name["'][^>]*>([^<]+)</i,
  /<div class=["']name position-relative["']>\s*<h4>([^<>"]+)<\/h4>/i,
  />File\s*:\s*<font[^>]*>([^<>"]+)</i,
  /<input[^>]+name=["']fname["'][^>]+value=["']([^"']+)["']/i,
  /<div class=["'][^"']*name[^"']*["'][^>]*>\s*<h\d[^>]*>([^<]+)</i,
  /<h1[^>]*class=["'][^"']*file[^"']*["'][^>]*>([^<]+)</i,
  /<title>\s*Download\s+([^<]+?)\s*<\/title>/i,
];

const DEFAULT_SIZES = [
  /<span[^>]+class=["'][^"']*file-size[^"']*["'][^>]*>([^<]+)</i,
  /class=["']file-size["']>([^<>"]+)</i,
  /\[<font[^>]*>(\d+[^<>"]+)<\/font>\]/i,
  /\(\s*([\d.,]+\s*(?:B|KB|MB|GB|TB))\s*\)/i,
  /Size\s*:?\s*<[^>]*>\s*([\d.,]+\s*(?:B|KB|MB|GB|TB))/i,
];

/** Final download URLs, after JD's `getDownloadurlRegexes`: `/d/`, `/files/`, `/dl/` paths on the
 * site, its subdomains, its CDNs or a bare IP. */
function directPatterns(hosts: string[]): RegExp[] {
  const hostRe = `(?:\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|(?:[a-z0-9-]+\\.)*(?:${hosts.map(escapeRe).join('|')}))`;
  const path = `(?::\\d+)?/(?:files|d|cgi-bin/dl\\.cgi|dl)/(?:\\d+/)?[a-z0-9]+/`;
  return [
    new RegExp(`"(https?://${hostRe}${path}[^<>"/]*)"`, 'i'),
    new RegExp(`'(https?://${hostRe}${path}[^<>"'/]*)'`, 'i'),
    new RegExp(`(https?://${hostRe}${path}[^<>"'/\\s]*)`, 'i'),
  ];
}

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
  const directs = cfg.directLinkPatterns ?? directPatterns([...cfg.domains, ...(cfg.downloadHosts ?? [])]);
  const userApi = !!(cfg.apiBase && cfg.userApiKeys);

  const cookieHelp: Bilingual = {
    de:
      `Im Browser bei ${host} anmelden, dann das Cookie „xfss“ kopieren ` +
      `(Entwicklertools → Anwendung/Speicher → Cookies → ${host}) und im Account als Passwort „xfss=…“ eintragen.`,
    en:
      `Log in at ${host} in the browser, then copy the cookie “xfss” ` +
      `(developer tools → Application/Storage → Cookies → ${host}) and enter it as the account password “xfss=…”.`,
  };

  const fileId = (link: string): string => {
    const m = linkRe.exec(link);
    if (!m) {
      throw new OfflineError({
        de: 'Link hat kein gültiges Dateikennzeichen',
        en: 'The link has no valid file id',
      });
    }
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
  /**
   * Web requests of this account. In cookie mode the user's cookie goes into the cookie jar
   * (like JD's `setCookies(userCookies)`), not into a fixed header: the site may renew the
   * session while we browse, and the jar keeps the renewed cookie for the next request and
   * across restarts. It is seeded only while the jar has no session yet, so a renewed
   * cookie is not overwritten by the stale value the user pasted.
   */
  function web(ctx: Ctx, m: Mode | null) {
    if (m?.kind === 'cookie' && !/(?:^|;\s*)xfss=/.test(ctx.cookies.get(base))) {
      const pairs = m.cookie.split(';').map((p) => p.trim()).filter((p) => p.includes('='));
      if (!pairs.some((p) => /^lang=/i.test(p))) pairs.push('lang=english');
      for (const pair of pairs) ctx.cookies.set(base, `${pair}; Domain=${host}; Path=/`);
    }
    return {
      get: (url: string, opts?: HttpOptions) => ctx.http.get(url, opts),
      post: (url: string, body: Record<string, string>, opts?: HttpOptions) => ctx.http.post(url, body, opts),
    };
  }

  /** The page without scripts, styles and comments (like JD's `correctBR`): XFS templates carry
   * texts for free users and commented-out buttons that are not shown to premium users. */
  function visible(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  }

  /** JD's `isLoggedin`: a visible logout link or a link to the own account page. */
  function loggedIn(res: HttpResponse): boolean {
    const html = visible(res.body);
    const a = `<a[^<]*href\\s*=\\s*["'][^"']*`;
    const logout = new RegExp(`${a}(?:[?&]op=logout|/(?:user_)?logout/?["']|/logout\\.html["'])`, 'i');
    const myAccount = new RegExp(`${a}(?:[?&]op=my_account|/my[-_]account["']|/account/?["'])`, 'i');
    return logout.test(html) || myAccount.test(html);
  }

  /** Absolute target of a redirect response, or null. */
  function redirectOf(res: HttpResponse): string | null {
    const loc = res.header('location');
    return res.status >= 300 && res.status < 400 && loc ? resolveUrl(res.url, loc) : null;
  }

  /** A page of the site itself (not a download server like srv12.ddownload.com or a CDN). */
  function isSitePage(url: string): boolean {
    const hostOf = /^https?:\/\/([^/:?#]+)/i.exec(url)?.[1]?.toLowerCase().replace(/^www\./, '');
    return !!hostOf && cfg.domains.includes(hostOf);
  }

  function isCloudflare(res: HttpResponse): boolean {
    return (res.status === 403 || res.status === 503) && /cf-chl|Just a moment|challenge-platform/i.test(res.body);
  }

  /** Errors that are certain wherever they show up. */
  function assertOnline(res: HttpResponse) {
    const html = visible(res.body);
    if (res.status === 404 || offline.some((p) => p.test(html))) throw new OfflineError();
    if (isCloudflare(res)) {
      throw new TemporaryError({
        de: `${cfg.name}: Cloudflare-Prüfung, später erneut`,
        en: `${cfg.name}: Cloudflare check, trying later`,
      });
    }
    if (/>\s*This server is in maintenance mode/i.test(html)) {
      throw new TemporaryError({ de: `${cfg.name}: Server in Wartung`, en: `${cfg.name}: server under maintenance` });
    }
    if (/>\s*Please enter your e-mail/i.test(html)) {
      throw new AccountError({
        de: `${cfg.name}: im Account unter ${host}/?op=my_account eine E-Mail-Adresse eintragen`,
        en: `${cfg.name}: add an e-mail address to the account at ${host}/?op=my_account`,
      });
    }
    if (res.status >= 500) throw new TemporaryError(`${cfg.name}: HTTP ${res.status}`);
  }

  /** Last resort when no link was found, like JD's `checkErrorsLastResort`: limits and the
   * site's own error box, quoted so the user sees what the hoster said. */
  function lastResort(res: HttpResponse, steps: string[], redirects: string[]): never {
    const html = visible(res.body);
    const limit =
      match(html, />\s*(You have reached the maximum limit \d+ files in \d+ hours)/i) ??
      match(html, /((?:You have reached the download[- ]limit|You have to wait)[^<>]+)/i);
    if (limit) throw new AccountError(`${cfg.name}: ${limit}`);
    if (/premium only|only premium|available for Premium Users only|upgrade your account/i.test(html)) {
      throw new AccountError({
        de: `${cfg.name}: Account ist nicht Premium`,
        en: `${cfg.name}: the account is not premium`,
      });
    }
    const siteError = match(html, /class=["'][^"']*(?:\berr\b|alert-danger)[^"']*["'][^>]*>\s*([^<]{3,})</i);
    const path = steps.join(' → ');
    const hops = redirects.map((r) => r.replace(/^https?:\/\/[^/]+/, '')).join(' → ');
    throw new TemporaryError({
      de: `${cfg.name}: Direktlink nicht gefunden (${steps.length ? `nach ${path}` : 'kein Download-Formular'}, HTTP ${res.status}` +
        `${hops ? `, weitergeleitet: ${hops}` : ''}${siteError ? `, Seite: „${siteError}“` : ''})`,
      en: `${cfg.name}: direct link not found (${steps.length ? `after ${path}` : 'no download form'}, HTTP ${res.status}` +
        `${hops ? `, redirected: ${hops}` : ''}${siteError ? `, page: “${siteError}”` : ''})`,
    });
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
      throw new TemporaryError({
        de: `${cfg.name}-API: unerwartete Antwort (HTTP ${res.status})`,
        en: `${cfg.name} API: unexpected answer (HTTP ${res.status})`,
      });
    }
    if (data.status === 403 || /invalid key|wrong key/i.test(data.msg || '')) {
      throw new AccountError({ de: `${cfg.name}-API: ungültiger API-Key`, en: `${cfg.name} API: invalid API key` });
    }
    if (data.status === 404) throw new OfflineError();
    if (data.status !== 200) throw new TemporaryError(`${cfg.name}-API: ${data.msg || data.status}`);
    return data.result as T;
  }

  // ---- web session -----------------------------------------------------------------

  /** Last account-page answer that did not look logged in, for the error message. */
  let lastAccountDetail: Bilingual = { de: '', en: '' };

  async function accountPage(ctx: Ctx, m: Mode): Promise<HttpResponse | null> {
    // Follow redirects: some sites move the account page; logged out ends on the login form.
    const res = await web(ctx, m).get(`${base}/?op=my_account`);
    if (isCloudflare(res)) {
      throw new TemporaryError({
        de: `${cfg.name}: Cloudflare-Prüfung, später erneut`,
        en: `${cfg.name}: Cloudflare check, trying later`,
      });
    }
    if (res.status === 429 || res.status >= 500) {
      throw new TemporaryError({
        de: `${cfg.name}: HTTP ${res.status} beim Prüfen der Anmeldung`,
        en: `${cfg.name}: HTTP ${res.status} while checking the login`,
      });
    }
    // Like JD: sites comment out the logout button for expired sessions, so ignore comments and scripts.
    if (res.status === 200 && !/op=login|\/login/i.test(res.url) && loggedIn(res)) return res;
    const where = `HTTP ${res.status}, ${res.url.replace(/^https?:\/\/[^/]+/, '')}`;
    lastAccountDetail = { de: `Kontoseite: ${where}`, en: `account page: ${where}` };
    return null;
  }

  /** Makes sure the session is logged in and returns the account page. */
  async function session(ctx: Ctx, m: Mode): Promise<HttpResponse> {
    const existing = await accountPage(ctx, m);
    if (existing) return existing;
    if (m.kind === 'cookie') {
      // The jar may hold a renewed cookie that stopped working; try the pasted one once more.
      const pasted = /(?:^|;\s*)xfss=([^;]+)/.exec(m.cookie)?.[1];
      const current = /(?:^|;\s*)xfss=([^;]+)/.exec(ctx.cookies.get(base))?.[1];
      if (pasted && current !== pasted) {
        ctx.cookies.set(base, `xfss=${pasted}; Domain=${host}; Path=/`);
        const retry = await accountPage(ctx, m);
        if (retry) return retry;
      }
      throw new AccountError({
        de: `${cfg.name}: Sitzungs-Cookie ungültig oder abgelaufen (${lastAccountDetail.de}). ${cookieHelp.de}`,
        en: `${cfg.name}: session cookie invalid or expired (${lastAccountDetail.en}). ${cookieHelp.en}`,
      });
    }
    if (m.kind !== 'password') {
      throw new AccountError({
        de: `${cfg.name}: keine Web-Anmeldung möglich`,
        en: `${cfg.name}: web login not possible`,
      });
    }

    const loginUrl = `${base}${cfg.loginPath ?? '/login.html'}`;
    const page = await ctx.http.get(loginUrl);
    const forms = parseForms(page.body);
    const form =
      forms.find((f) => /name=["']FL["']/i.test(f.html)) ??
      forms.find((f) => f.fields.op === 'login' || 'password' in f.fields);
    const fields: Record<string, string> = { ...(form?.fields ?? {}), op: 'login', redirect: base, login: m.user, password: m.password };
    const action = form?.action ? resolveUrl(loginUrl, form.action) : loginUrl;
    // A captcha on the login form (ddownload: Turnstile) goes to the user.
    const solved = await tokenCaptcha(ctx, form?.html ?? '', fields, page);
    const res = await ctx.http.post(action, fields);

    const after = await accountPage(ctx, m);
    if (after) return after;
    if (/Incorrect Login or Password/i.test(res.body)) {
      throw new AccountError({
        de: `${cfg.name}: Benutzername oder Passwort falsch`,
        en: `${cfg.name}: wrong user name or password`,
      });
    }
    if (/account (?:was|has been) banned/i.test(res.body)) {
      throw new AccountError({
        de: `${cfg.name}: Account gesperrt`,
        en: `${cfg.name}: account banned`,
      });
    }
    if (solved) {
      throw new AccountError({
        de: `${cfg.name}: Login trotz gelöstem Captcha fehlgeschlagen. ${cookieHelp.de}`,
        en: `${cfg.name}: login failed although the captcha was solved. ${cookieHelp.en}`,
      });
    }
    if (CAPTCHA_WORDS.test(form?.html ?? page.body)) {
      throw new AccountError({
        de: `${cfg.name} verlangt beim Login ein Captcha, das Haul nicht lösen kann. ${cookieHelp.de}`,
        en: `${cfg.name} asks for a captcha at login that Haul cannot solve. ${cookieHelp.en}`,
      });
    }
    throw new AccountError({ de: `${cfg.name}: Login fehlgeschlagen`, en: `${cfg.name}: login failed` });
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
    // A future expiry date is proof enough; the badge pattern breaks with every redesign.
    const byDate = validUntil !== undefined ? validUntil > Date.now() : undefined;
    const premium = cfg.premiumPattern ? cfg.premiumPattern.test(html) || byDate === true : byDate;
    return {
      valid: true,
      premium,
      trafficLeft,
      validUntil,
      message: premium === false ? bilingual('Account ist nicht Premium', 'The account is not premium') : undefined,
    };
  }

  function currentMode(ctx: Ctx): Mode {
    const acc = ctx.account.get();
    if (!acc) {
      throw new AccountError({
        de: `${cfg.name}: kein Premium-Account hinterlegt`,
        en: `${cfg.name}: no premium account set up`,
      });
    }
    return mode(acc.user, acc.secret);
  }

  // ---- free mode (JD: doFree) --------------------------------------------------------

  /** JD's checkErrors for free downloads: limits with their wait, premium-only, site states. */
  function freeErrors(res: HttpResponse) {
    const html = visible(res.body);
    cfg.checkErrors?.(html, res);
    const n = cfg.name;
    if (/>\s*Wrong password/i.test(html)) {
      throw new PluginError('fatal', { de: `${n}: falsches Datei-Passwort`, en: `${n}: wrong file password` });
    }
    if (/>\s*Wrong captcha/i.test(html)) {
      throw new TemporaryError({ de: `${n}: Captcha falsch`, en: `${n}: wrong captcha` });
    }
    if (/>\s*Skipped countdown\s*</i.test(html)) {
      throw new TemporaryError({ de: `${n}: Countdown übersprungen`, en: `${n}: countdown skipped` });
    }
    const wait =
      match(html, /((?:You have reached the download[- ]limit|You have to wait)[^<>]+)/i) ??
      match(html, /Download limit reached.\s*Please wait\s*(.*?)\s*before your next download/i);
    if (wait) {
      // JD: ERROR_IP_BLOCKED, for every download from the site.
      throw new HosterLimitError(
        { de: `${n}: Download-Limit, Wartezeit bis zum nächsten Download („${wait}“)`, en: `${n}: download limit, waiting for the next download (“${wait}”)` },
        parseWait(wait),
      );
    }
    const perHours = match(html, />\s*(You have reached the maximum limit \d+ files in \d+ hours)/i);
    if (perHours) throw new HosterLimitError(`${n}: ${perHours}`, 15 * 60);
    if (/You're using all download slots for IP/i.test(html)) {
      throw new HosterLimitError({ de: `${n}: alle Download-Slots dieser IP belegt`, en: `${n}: all download slots of this IP in use` }, 5 * 60);
    }
    if (/Error happened when generating Download Link/i.test(html)) {
      throw new TemporaryError({ de: `${n}: Fehler beim Erzeugen des Download-Links`, en: `${n}: error generating the download link` }, 10 * 60);
    }
    for (const p of PREMIUM_ONLY) {
      const m = new RegExp(`>(${p.source})`, 'i').exec(res.body);
      if (m) {
        throw new PluginError('fatal', {
          de: `${n}: nur mit Premium („${decodeHtml(m[1]).trim()}“)`,
          en: `${n}: premium only (“${decodeHtml(m[1]).trim()}”)`,
        });
      }
    }
    if (/>\s*Expired download session/i.test(html)) {
      throw new TemporaryError({ de: `${n}: Download-Sitzung abgelaufen`, en: `${n}: download session expired` }, 10 * 60);
    }
    if (res.status === 500 || />\s*(?:This server is in maintenance mode|Technical Maintenance\s*<)/i.test(html)) {
      throw new TemporaryError({ de: `${n}: Server in Wartung`, en: `${n}: server under maintenance` }, 30 * 60);
    }
    if (/>\s*Downloads disabled for this file/i.test(html)) {
      throw new PluginError('fatal', { de: `${n}: Download vom Uploader deaktiviert`, en: `${n}: the uploader disabled downloads` });
    }
    if (/>\s*Downloads are disabled for your country/i.test(html)) {
      throw new PluginError('fatal', { de: `${n}: Downloads für dein Land gesperrt`, en: `${n}: downloads are disabled for your country` });
    }
    if (/>\s*File was locked by administrator/i.test(html)) {
      throw new PluginError('fatal', { de: `${n}: Datei vom Admin gesperrt`, en: `${n}: file locked by the administrator` });
    }
    if (/>\s*Couldn't generate direct link/i.test(html)) {
      throw new TemporaryError({ de: `${n}: Direktlink konnte nicht erzeugt werden`, en: `${n}: could not generate the direct link` });
    }
  }

  /** JD's handleCaptcha: the plain-text captcha is solved; anything else needs a human. */
  /**
   * JD's handleCaptcha: the plain-text captcha is read from the page; reCaptcha, hCaptcha and
   * Turnstile go to the user, who solves them in the browser on the hoster's page.
   */
  async function solveCaptcha(ctx: Ctx, form: { html: string }, fields: Record<string, string>, page: HttpResponse) {
    if (form.html.includes(';background:#ccc;text-align')) {
      // JD looks in the whole page too: the digits may sit outside the form.
      const code = plainTextCaptcha(form.html) ?? plainTextCaptcha(page.body);
      if (!code) throw new TemporaryError({ de: `${cfg.name}: Text-Captcha nicht lesbar`, en: `${cfg.name}: plain-text captcha unreadable` });
      fields.code = code;
      return;
    }
    await tokenCaptcha(ctx, form.html, fields, page);
    if (/\/captchas\//i.test(form.html)) {
      throw new PluginError('fatal', {
        de: `${cfg.name}: Bild-Captcha (noch nicht unterstützt)`,
        en: `${cfg.name}: image captcha (not supported yet)`,
      });
    }
  }

  /** A reCaptcha, hCaptcha or Turnstile widget in `html` (or the page): solved by the user. */
  async function tokenCaptcha(ctx: Ctx, html: string, fields: Record<string, string>, page: HttpResponse): Promise<boolean> {
    const found = findCaptcha(html) ?? findCaptcha(visible(page.body));
    if (!found) return false;
    ctx.log.info(`${cfg.name}: ${found.kind} – wartet auf Lösung im Browser`);
    const token = await ctx.captcha.solve({ kind: found.kind, siteKey: found.siteKey, pageUrl: page.url });
    fields[CAPTCHA_FIELD[found.kind]] = token;
    // hCaptcha fills both fields in the browser; XFS sites often read g-recaptcha-response.
    if (found.kind === 'hcaptcha') fields['g-recaptcha-response'] = token;
    return true;
  }

  async function resolveFree(link: string, ctx: Ctx): Promise<Resolved> {
    const url = fileUrl(link);
    let fileName: string | undefined;
    let fileSize: number | undefined;
    const scan = (page: HttpResponse) => {
      const html = visible(page.body);
      fileName ??= match(html, ...names) ?? parseForms(html).map((f) => f.fields.fname).find((x) => !!x && x.trim().length > 0);
      fileSize ??= parseSize(match(html, ...sizes));
    };
    const direct = (target: string): Resolved => {
      ctx.log.info(`Direktlink (free): ${target.replace(/^(https?:\/\/[^/]+).*$/, '$1')}/… (${fileName ?? 'Name unbekannt'})`);
      return { url: target, name: fileName, size: fileSize, headers: { Referer: url }, maxConnections: cfg.freeMaxConnections ?? 1 };
    };
    /** A file, a redirect to it or a link to it on the page; follows redirects within the site. */
    const hooks = cfg.freeHooks ?? {};
    const get = (u: string) => ctx.http.get(u, { followRedirects: false, headers: cfg.headers });
    const post = (u: string, fields: Record<string, string>) =>
      ctx.http.post(u, fields, { followRedirects: false, headers: cfg.headers });
    const countdownOf = (html: string) => hooks.countdown?.(html) ?? countdown(html);
    const found = async (res: HttpResponse): Promise<{ link?: string; page: HttpResponse }> => {
      for (let hop = 0; hop < 5; hop++) {
        if (res.file) return { link: res.url, page: res };
        const target = redirectOf(res);
        if (!target) break;
        if (!isSitePage(target) || directs.some((p) => p.test(`"${target}"`))) return { link: target, page: res };
        res = await get(target);
      }
      scan(res);
      return { link: hooks.directLink?.(res) ?? match(res.body, ...directs), page: res };
    };

    let { link: dl, page: res } = await found(await get(url));
    if (dl) return direct(dl);
    assertOnline(res);
    freeErrors(res);
    const steps: string[] = [];

    // download1: the "Free Download" button (JD: findFormDownload1Free).
    const form1 = parseForms(visible(res.body)).find((f) => f.fields.op === 'download1');
    const download1: FreeStep | undefined = hooks.download1
      ? hooks.download1(res)
      : form1 && { fields: { ...form1.fields }, action: form1.action ?? undefined, html: form1.html };
    if (download1) {
      const fields = { ...download1.fields };
      delete fields.method_premium;
      // Usually a submit button, so not among the fields; JD takes its value from the page.
      if (!fields.method_free) {
        fields.method_free = /["']method_free["'][^>]*value=["']([^<>"']+)["']/i.exec(download1.html)?.[1] ?? 'Free Download';
      }
      const wait = countdownOf(res.body);
      if (wait) await ctx.wait(wait);
      steps.push('download1');
      ({ link: dl, page: res } = await found(await post(download1.action ? resolveUrl(url, download1.action) : url, fields)));
      if (dl) return direct(dl);
      assertOnline(res);
      freeErrors(res);
    }

    // download2: countdown, captcha, then the form; some sites need more than one round.
    for (let round = 0; round < 3; round++) {
      const forms = parseForms(visible(res.body));
      const form2 =
        forms.find((f) => /method_/.test(f.html) && (f.fields.op ?? '').includes('download')) ??
        forms.find((f) => /name=["']F1["']/i.test(f.html)) ??
        forms.find((f) => f.fields.op === 'download2');
      const found2: FreeStep | undefined = form2 && { fields: { ...form2.fields }, action: form2.action ?? undefined, html: form2.html };
      const download2 = hooks.download2 ? hooks.download2(res, fileId(link), found2) : found2;
      if (!download2) break;
      const started = Date.now();
      const fields: Record<string, string> = { ...download2.fields };
      if ('adblock_detected' in fields && !fields.adblock_detected) fields.adblock_detected = '0';
      if (/<input[^>]+type=["']password["'][^>]+name=["']password["']/i.test(download2.html)) {
        throw new PluginError('fatal', {
          de: `${cfg.name}: passwortgeschützte Datei (noch nicht unterstützt)`,
          en: `${cfg.name}: password-protected file (not supported yet)`,
        });
      }
      await solveCaptcha(ctx, download2, fields, res);
      const wait = countdownOf(res.body);
      const left = wait ? wait - (Date.now() - started) / 1000 : 0;
      if (left > 0) await ctx.wait(left);
      steps.push(fields.op ?? 'download2');
      ({ link: dl, page: res } = await found(await post(download2.action ? resolveUrl(url, download2.action) : url, fields)));
      if (dl) return direct(dl);
      assertOnline(res);
      freeErrors(res);
    }
    lastResort(res, steps, []);
  }

  return {
    id: cfg.id,
    name: cfg.name,
    version: cfg.version,
    matches: [linkRe],
    accountRequired: cfg.accountRequired ?? true,
    account: {
      userLabel: { de: 'Benutzer', en: 'User' },
      secretLabel: userApi
        ? { de: 'Passwort, API-Key oder xfss-Cookie', en: 'Password, API key or xfss cookie' }
        : { de: 'Passwort oder xfss-Cookie', en: 'Password or xfss cookie' },
      help: {
        de:
          `Benutzer und Passwort wie in JDownloader. Verlangt ${host} beim Login ein Captcha, ` +
          `einmal im Browser anmelden und das Cookie „xfss“ als Passwort „xfss=…“ eintragen.` +
          (userApi ? ' Mit leerem Benutzer wird das Passwortfeld als API-Key verwendet.' : ''),
        en:
          `User name and password as in JDownloader. If ${host} asks for a captcha at login, ` +
          `log in once in the browser and enter its cookie “xfss” as password “xfss=…”.` +
          (userApi ? ' With an empty user name, the password field is used as API key.' : ''),
      },
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
      // The core calls this without an account (like JD's link check): the public file page shows
      // name and size. Never follow redirects here; a redirect may be the file itself.
      const res = await web(ctx, m?.kind === 'cookie' ? m : null).get(fileUrl(link), { followRedirects: false, headers: cfg.headers });
      const html = visible(res.body);
      if (res.status === 404 || offline.some((p) => p.test(html))) return { online: false };
      const name = match(html, ...names) ?? parseForms(html).map((f) => f.fields.fname).find((n) => !!n && n.trim().length > 0);
      if (!name) ctx.log.warn(`${cfg.name}: kein Dateiname auf der Dateiseite gefunden (HTTP ${res.status}, ${match(res.body, /<title>\s*([^<]*)</i) ?? 'ohne Titel'})`);
      return { online: true, name, size: parseSize(match(html, ...sizes)) };
    },

    async resolve(link, ctx): Promise<Resolved> {
      if (cfg.free && !ctx.account.get()) return resolveFree(link, ctx);
      const m = currentMode(ctx);
      const id = fileId(link);

      if (m.kind === 'api') {
        const r = await api<{ url?: string; size?: number | string; name?: string }>(ctx, '/file/direct_link', {
          key: m.key,
          file_code: id,
        });
        if (!r || !r.url) {
          throw new TemporaryError({
            de: `${cfg.name}-API lieferte keinen Direktlink`,
            en: `${cfg.name} API returned no direct link`,
          });
        }
        return { url: r.url, name: r.name, size: r.size !== undefined ? Number(r.size) : undefined, maxConnections: cfg.maxConnections };
      }

      const http = web(ctx, m);
      const url = fileUrl(link);
      // File name and size from the pages on the way (JD: scanInfo). Links from crypters like
      // filecrypt carry only the file id, and the CDN may not send a name either.
      let fileName: string | undefined;
      let fileSize: number | undefined;
      const scan = (page: HttpResponse) => {
        const html = visible(page.body);
        fileName ??=
          match(html, ...names) ?? parseForms(html).map((f) => f.fields.fname).find((n) => !!n && n.trim().length > 0);
        fileSize ??= parseSize(match(html, ...sizes));
      };
      const direct = (target: string): Resolved => {
        ctx.log.info(`Direktlink: ${target.replace(/^(https?:\/\/[^/]+).*$/, '$1')}/… (${fileName ?? 'Name unbekannt'})`);
        return { url: target, name: fileName, size: fileSize, headers: { Referer: url }, maxConnections: cfg.maxConnections };
      };

      // Like JD (validateCookies=false): trust the session and open the file right away.
      let res = await http.get(url, { followRedirects: false });
      let sessionChecked = false;
      const steps: string[] = [];
      const redirects: string[] = [];
      for (let round = 0; round < 10; round++) {
        // The server answered with the file itself (JD: looksLikeDownloadableContent).
        if (res.file) return direct(res.url);
        if (!redirectOf(res)) scan(res);
        const target = redirectOf(res);
        if (target) {
          // A redirect to a download server or CDN, or to a download path, is the file
          // ("direct downloads" enabled or after the form). A redirect within the site is an
          // intermediate page: follow it.
          if (!isSitePage(target) || directs.some((p) => p.test(`"${target}"`))) return direct(target);
          if (/[?&]op=payments|\/upgrade|\/premium/i.test(target)) {
            // JD's isPremiumOnlyURL: the site does not treat this session as premium right now.
            const where = target.replace(/^https?:\/\/[^/]+/, '');
            throw new AccountError({
              de: `${cfg.name} leitet zur Premium-Kaufseite um (${where}): ` +
                'die Sitzung gilt dort gerade nicht als Premium (abgemeldet oder Sitzung erneuert).',
              en: `${cfg.name} redirects to the premium sales page (${where}): ` +
                'the session does not count as premium there right now (logged out or session renewed).',
            });
          }
          if (/op=login|\/login/i.test(target)) {
            if (sessionChecked) {
              throw new AccountError({
                de: `${cfg.name}: nach der Anmeldung wieder zur Login-Seite umgeleitet`,
                en: `${cfg.name}: redirected to the login page again after logging in`,
              });
            }
            await session(ctx, m);
            sessionChecked = true;
            res = await http.get(url, { followRedirects: false });
            continue;
          }
          redirects.push(target);
          res = await http.get(target, { followRedirects: false });
          continue;
        }
        const inline = match(res.body, ...directs);
        if (inline) return direct(inline);
        assertOnline(res);
        if (!sessionChecked && steps.length === 0 && !loggedIn(res)) {
          // Logged out (first use or expired session): log in / verify the cookie once.
          await session(ctx, m);
          sessionChecked = true;
          res = await http.get(url, { followRedirects: false });
          continue;
        }
        // Submit the download form (JD: form F1, pyLoad: op=download*); some sites need several steps.
        const forms = parseForms(visible(res.body));
        const form =
          forms.find((f) => /name=["']F1["']/i.test(f.html)) ?? forms.find((f) => /^download/.test(f.fields.op ?? ''));
        if (!form || steps.length >= 5) break;
        const fields: Record<string, string> = { ...form.fields, referer: form.fields.referer || url };
        delete fields.method_free;
        fields.method_premium = 'Premium Download';
        steps.push(fields.op ?? '?');
        res = await http.post(form.action ? resolveUrl(url, form.action) : url, fields, { followRedirects: false });
      }
      lastResort(res, steps, redirects);
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
