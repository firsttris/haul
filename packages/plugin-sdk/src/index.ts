/**
 * Types and helpers for Haul hoster plugins.
 *
 * A plugin only does "link in, direct URL plus headers out". Everything that touches the
 * file's bytes (ranges, resume, speed limit) is done by the Rust core. Plugins run in
 * QuickJS inside the server: there is no Node, no `fetch`, no timers — use `ctx`.
 */

export interface HttpOptions {
  headers?: Record<string, string>;
  /** Default `true`. Set to `false` to read a `Location` header yourself. */
  followRedirects?: boolean;
  timeoutMs?: number;
  /** Sent as JSON body. */
  json?: unknown;
  /** Sent as `application/x-www-form-urlencoded`. */
  form?: Record<string, string>;
  /** Raw body. */
  body?: string;
  /**
   * Read the answer as a page, whatever its headers say (like JD's getPage/postPage). By
   * default an attachment or a binary content type counts as a file and its body is not read.
   */
  page?: boolean;
}

export interface HttpRequest extends HttpOptions {
  method?: string;
  url: string;
}

export interface HttpResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  /** Lower-case header names; repeated headers are joined (`set-cookie` with newlines). */
  headers: Record<string, string>;
  body: string;
  /** The response is a file (attachment / binary); its body was not loaded. Download `url`. */
  file: boolean;
  ok(): boolean;
  text(): string;
  json<T = unknown>(): T;
  header(name: string): string | null;
}

export interface Http {
  request(req: HttpRequest): Promise<HttpResponse>;
  get(url: string, opts?: HttpOptions): Promise<HttpResponse>;
  /** A string body is sent as-is, an object as form fields. */
  post(url: string, body?: string | Record<string, string> | null, opts?: HttpOptions): Promise<HttpResponse>;
}

export interface Logger {
  (...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export interface Account {
  id: number;
  /** May be empty, e.g. when the account is only an API key. */
  user: string;
  /** Password or API key. */
  secret: string;
}

export type CryptoOp = 'pbkdf2Sha512' | 'aesEncrypt' | 'modPow' | 'megaPrepareKey' | 'megaUserHashV1' | 'megaHashcash';

export interface Ctx {
  pluginId: string;
  /** Cookies are kept per account between calls, so a login survives until it expires. */
  http: Http;
  wait(seconds: number): Promise<void>;
  log: Logger;
  account: { get(): Account | null };
  /** Hashes computed by the core (QuickJS has no crypto). */
  hash: {
    /** Lower-case hex SHA-256 of the UTF-8 text. */
    sha256(text: string): string;
  };
  /** Ciphers computed by the core. */
  crypto: {
    /**
     * AES-128 decryption without padding (mega.nz keys and attributes). Key, iv (CBC, default
     * zeros) and data as hex; data a multiple of 16 bytes. Returns hex.
     */
    aesDecrypt(opts: { mode: 'ecb' | 'cbc'; key: string; iv?: string; data: string }): string;
    /**
     * Heavier operations in the core, hex in and out (the MEGA login, JD/pyLoad):
     * `pbkdf2Sha512 {password, salt, iterations, length}`, `aesEncrypt {mode, key, iv?, data}`,
     * `modPow {base, exp, mod}` (RSA; mod as hex or factors), `megaPrepareKey {password}` and
     * `megaUserHashV1 {email, key}` (v1 accounts),
     * `megaHashcash {challenge, easiness}` (returns the base64url nonce).
     */
    run(op: CryptoOp, args: Record<string, unknown>): Promise<string>;
  };
  /**
   * Captchas the user solves in the browser, on the hoster's page (like JD's browser solver).
   * Waits until solved (up to 10 minutes) and returns the token for the form field
   * (`g-recaptcha-response`, `h-captcha-response`, `cf-turnstile-response`); for an image
   * captcha, the text the user typed. Throws when the user cancels or does not solve it in time.
   */
  captcha: {
    solve(req: CaptchaRequest): Promise<string>;
  };
  /**
   * The download password of a protected file or folder (JD: `getDownloadPassword`, else
   * `getUserInput("Password?")`). Available in `resolve` and `crawl`. The core keeps the
   * password with the download; files from a crawl get the folder's. See `withPassword`.
   */
  password: {
    /**
     * The saved password, else the user is asked in the UI (up to 10 minutes). `wrong: true`:
     * the hoster rejected the last one; it is forgotten and the user asked again (JD's
     * `setDownloadPassword(null)`). Throws when the user cancels or does not answer.
     */
    get(opts?: { wrong?: boolean }): Promise<string>;
    /** Forgets a rejected password without asking for another one. */
    forget(): Promise<void>;
    /** The saved password, or null; never asks (e.g. to send it with the first request). */
    saved(): Promise<string | null>;
  };
  /** The account's cookie jar, shared by all requests and kept across restarts. */
  cookies: {
    /** `Cookie` header value the jar would send to `url`. */
    get(url: string): string;
    /** Adds a cookie like a `Set-Cookie` header from `url` would, e.g. `a=b; Domain=.x.com; Path=/`. */
    set(url: string, cookie: string): void;
  };
}

/** Captchas solved with a widget on the hoster's page; the answer is a token. */
export type TokenCaptchaKind = 'recaptcha' | 'hcaptcha' | 'turnstile';

export type CaptchaRequest =
  | {
      kind: TokenCaptchaKind;
      /** `data-sitekey` of the widget. */
      siteKey: string;
      /** The page that shows the captcha; the token is bound to its domain. */
      pageUrl: string;
      /** reCaptcha Enterprise. */
      enterprise?: boolean;
    }
  | {
      /** A picture with text: the core loads it with the plugin's cookies, the user types it in the UI. */
      kind: 'image';
      imageUrl: string;
      /** The page with the picture (sent as Referer). */
      pageUrl: string;
      /** For loading the picture, e.g. the plugin's User-Agent. */
      headers?: Record<string, string>;
    };

/** The token-captcha widget on a page, if any: kind and site key (JD's detection order). */
export function findCaptcha(html: string): { kind: TokenCaptchaKind; siteKey: string } | undefined {
  const key = (cls: string) =>
    new RegExp(`class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*data-sitekey=["']([^"']+)["']`, 'i').exec(html)?.[1] ??
    new RegExp(`data-sitekey=["']([^"']+)["'][^>]*class=["'][^"']*\\b${cls}\\b`, 'i').exec(html)?.[1];
  const turnstile = key('cf-turnstile');
  if (turnstile) return { kind: 'turnstile', siteKey: turnstile };
  const h = key('h-captcha');
  if (h) return { kind: 'hcaptcha', siteKey: h };
  const g =
    key('g-recaptcha') ??
    (/g-recaptcha|recaptcha\/api\.js/i.test(html) ? /data-sitekey=["']([^"']+)["']/i.exec(html)?.[1] : undefined) ??
    recaptchaKeyInCode(html);
  if (g) return { kind: 'recaptcha', siteKey: g };
  return undefined;
}

/** JD AbstractRecaptchaV2.apiKeyRegex. */
const RECAPTCHA_KEY = '6L[\\w-]{14,}';

/**
 * A reCaptcha v2 site key that is not in a `data-sitekey` attribute (JD AbstractRecaptchaV2
 * findNextSiteKey): `grecaptcha.render(container, { sitekey: … })` in a script, or the
 * no-JavaScript fallback iframe `…/recaptcha/api/fallback?k=…`. JD's v3 variants (`render=` in
 * the script URL, `grecaptcha.execute(key)`) are left out: v3 has no widget to solve.
 */
export function recaptchaKeyInCode(html: string): string | undefined {
  const render = /recaptcha(?:\.enterprise)?\.render\s*\([^{;]*?,\s*\{([\s\S]*?)\}\s*\)/i.exec(html)?.[1];
  const inRender = render && new RegExp(`(["']?)sitekey\\1\\s*:\\s*(["']?)\\s*(${RECAPTCHA_KEY})\\s*\\2`, 'i').exec(render)?.[3];
  return inRender || new RegExp(`google\\.com/recaptcha/(?:api|enterprise)/fallback\\?k=(${RECAPTCHA_KEY})`, 'i').exec(html)?.[1];
}

/** The form field a solved token goes into. */
export const CAPTCHA_FIELD: Record<TokenCaptchaKind, string> = {
  recaptcha: 'g-recaptcha-response',
  hcaptcha: 'h-captcha-response',
  turnstile: 'cf-turnstile-response',
};

/** What a `withPassword` attempt returns when the hoster rejected the password. */
export const WRONG_PASSWORD: unique symbol = Symbol('wrong password');

/**
 * JD's PasswordSolver: the saved password, else the user's; after a rejection the user is asked
 * again, three tries in all, then the download fails with "wrong password" (the password is
 * forgotten, so a restart asks again). `attempt` sends the password and returns the result, or
 * `WRONG_PASSWORD`.
 */
export async function withPassword<T>(
  ctx: Ctx,
  hoster: string,
  attempt: (password: string) => Promise<T | typeof WRONG_PASSWORD>,
): Promise<T> {
  let password = await ctx.password.get();
  for (let tries = 1; ; tries++) {
    const result = await attempt(password);
    if (result !== WRONG_PASSWORD) return result;
    if (tries >= 3) {
      await ctx.password.forget();
      throw new PluginError('fatal', { de: `${hoster}: Passwort falsch`, en: `${hoster}: wrong password` });
    }
    password = await ctx.password.get({ wrong: true });
  }
}

/**
 * A checksum the hoster publishes (JD HashInfo). The core verifies the finished file with it:
 * a mismatch loads the file once more, a second one fails. `mega`: the 32-byte MEGA file key
 * as hex (its meta MAC). Unknown types or malformed values are ignored.
 */
export interface FileHash {
  type: 'md5' | 'sha1' | 'sha256' | 'mega';
  value: string;
}

export interface CheckResult {
  online: boolean;
  name?: string;
  size?: number;
  hash?: FileHash;
}

export interface Resolved {
  /** Direct URL the core downloads. */
  url: string;
  headers?: Record<string, string>;
  /** Extra cookies; the account's cookie jar is used automatically anyway. */
  cookies?: string | Record<string, string>;
  name?: string;
  size?: number;
  /** Upper bound for parallel connections to this file. */
  maxConnections?: number;
  /**
   * The hoster sends the file encrypted (mega.nz); the core decrypts it while writing.
   * Key and initial counter block as hex (16 bytes each).
   */
  decrypt?: { cipher: 'aes-128-ctr'; key: string; iv: string };
  /** Checksum of the (decrypted) file; else the one from `crawl`/`check`, if any. */
  hash?: FileHash;
}

/** One file found by `crawl`. `url` is what `check`/`resolve` get later. */
export interface CrawledFile {
  url: string;
  name?: string;
  size?: number;
  hash?: FileHash;
}

export interface CrawlResult {
  /** Suggested package name, e.g. the folder name. */
  packageName?: string;
  files: CrawledFile[];
}

export interface AccountInfo {
  valid: boolean;
  premium?: boolean;
  /** Bytes. */
  trafficLeft?: number;
  /** Unix time in milliseconds. */
  validUntil?: number;
  message?: string;
}

/** A text shown in the UI: the same for every language, or one per language (`de`, `en`). */
export type LocalizedText = string | { de?: string; en?: string };

export interface PluginDefinition {
  id: string;
  name?: string;
  version: number | string;
  /** The first plugin with a matching pattern handles a link. */
  matches: RegExp[];
  /** The hoster's domains, for the plugin list in the UI ("Unterstützt: …"). */
  domains?: string[];
  /** Without an account the link is not even tried. */
  accountRequired?: boolean;
  /**
   * Run calls without an account one at a time too (with an account they always are), e.g.
   * for a hoster whose API rate-limits guests (JD: getMaxConcurrentProcessingInstances = 1).
   */
  serial?: boolean;
  /** `crawl` gets the account too (`ctx.account`), e.g. to list private folders. */
  crawlWithAccount?: boolean;
  /**
   * Labels and hint for the account form in the UI; plain or per UI language.
   * `secretMultiline`: the secret is several lines (exported browser cookies), a text area.
   */
  account?: { userLabel?: LocalizedText; secretLabel?: LocalizedText; help?: LocalizedText; secretMultiline?: boolean };
  check?(link: string, ctx: Ctx): Promise<CheckResult>;
  /**
   * Folder links: expands a link into its files when links are added (like JD's crawler).
   * Runs without an account unless `crawlWithAccount`. Links the plugin does not expand
   * return `[link]` unchanged.
   */
  crawl?(link: string, ctx: Ctx): Promise<CrawlResult>;
  resolve(link: string, ctx: Ctx): Promise<Resolved>;
  checkAccount?(ctx: Ctx): Promise<AccountInfo>;
}

export function definePlugin<T extends PluginDefinition>(plugin: T): T {
  return plugin;
}

/** Both languages of a message; the UI shows the viewer's. */
export interface Bilingual {
  de: string;
  en: string;
}

/**
 * Packs a German and an English text into one string; it does not translate anything. The UI
 * shows the viewer's language. Needed where a message must be a plain string, e.g. to join it
 * with other text or for `AccountInfo.message`; errors take `{ de, en }` directly.
 *
 * The texts are framed with control characters (`\u0002` de `\u001f` en `\u0003`), so the
 * message survives the way through the core and the database and can sit inside other text.
 */
export function bilingual(de: string, en: string): string {
  const clean = (s: string) => s.replace(/[\u0002\u0003\u001f]/g, '');
  return `\u0002${clean(de)}\u001f${clean(en)}\u0003`;
}

/** A message given as plain string (same in both languages) or as `{ de, en }`. */
export type Message = string | Bilingual;

const toText = (m: Message) => (typeof m === 'string' ? m : bilingual(m.de, m.en));

/** The text of `message` in one language, e.g. for tests and logs. */
export function pickLang(message: string, lang: 'de' | 'en'): string {
  return message.replace(/\u0002([^\u0003]*?)(?:\u001f([^\u0003]*))?(?:\u0003|$)/g, (_, de: string, en?: string) =>
    lang === 'en' ? (en ?? de) : de,
  );
}

type Kind = 'offline' | 'temporary' | 'account' | 'fatal';

/**
 * Base of the errors a plugin throws. `message` is a plain string or `{ de, en }`:
 * `throw new OfflineError({ de: 'Datei gelöscht', en: 'File deleted' })`.
 */
export class PluginError extends Error {
  readonly haulKind: Kind;
  /** Seconds until the next try, if the hoster said (see `TemporaryError`). */
  readonly haulWait?: number;
  constructor(kind: Kind, message: Message, waitSeconds?: number) {
    super(toText(message));
    this.haulKind = kind;
    if (waitSeconds !== undefined && waitSeconds > 0) this.haulWait = Math.ceil(waitSeconds);
  }
}

/** The file is gone. The download fails without retry. */
export class OfflineError extends PluginError {
  constructor(message: Message = { de: 'Datei offline', en: 'File offline' }) {
    super('offline', message);
  }
}

/**
 * Try again later: server busy, limit reached, maintenance. With `waitSeconds` (e.g. the wait
 * a free hoster demands until the next download, JD's ERROR_IP_BLOCKED) the core tries again
 * exactly then, and the wait does not count as a failed attempt.
 */
export class TemporaryError extends PluginError {
  constructor(message: Message, waitSeconds?: number) {
    super('temporary', message, waitSeconds);
  }
}

/**
 * A limit of the hoster for this connection, not for one file: waits between free downloads,
 * "one download at a time", IP locks, no free slots (JD: ERROR_IP_BLOCKED and
 * ERROR_HOSTER_TEMPORARILY_UNAVAILABLE). Every download from this hoster waits `waitSeconds`,
 * without using up attempts.
 */
export class HosterLimitError extends PluginError {
  readonly haulScope = 'hoster';
  constructor(message: Message, waitSeconds: number) {
    super('temporary', message, waitSeconds);
  }
}

/** Login failed or the account cannot be used right now. */
export class AccountError extends PluginError {
  constructor(message: Message) {
    super('account', message);
  }
}

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  KIB: 1024,
  MB: 1024 ** 2,
  MIB: 1024 ** 2,
  GB: 1024 ** 3,
  GIB: 1024 ** 3,
  TB: 1024 ** 4,
  TIB: 1024 ** 4,
};

/** `"1.5 GB"`, `"700,2 MB"`, `"12345"` → bytes. */
export function parseSize(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const m = /([\d.,]+)\s*([KMGT]?i?B)?/i.exec(text.trim());
  if (!m) return undefined;
  let num = m[1];
  // "1.234,5" → "1234.5"; "1,234.5" → "1234.5"; "700,2" → "700.2"
  if (num.includes(',') && num.includes('.')) {
    num = num.lastIndexOf(',') > num.lastIndexOf('.') ? num.replace(/\./g, '').replace(',', '.') : num.replace(/,/g, '');
  } else {
    num = num.replace(',', '.');
  }
  const value = parseFloat(num);
  if (isNaN(value)) return undefined;
  const unit = (m[2] || 'B').toUpperCase();
  return Math.round(value * (UNITS[unit] ?? 1));
}

/** First capture group of the first matching pattern, HTML entities decoded and trimmed. */
export function match(text: string, ...patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m && m[1] !== undefined) return decodeHtml(m[1]).trim();
  }
  return undefined;
}

export function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export interface HtmlForm {
  action: string | null;
  method: string;
  fields: Record<string, string>;
  html: string;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeHtml(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** All `<form>`s with their `<input>`, `<select>` (first/selected option) and `<textarea>` values. */
export function parseForms(html: string): HtmlForm[] {
  const forms: HtmlForm[] = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = formRe.exec(html))) {
    const [, attrs, inner] = fm;
    const fields: Record<string, string> = {};
    const inputRe = /<input\b[^>]*>/gi;
    let im: RegExpExecArray | null;
    while ((im = inputRe.exec(inner))) {
      const tag = im[0];
      const name = attr(tag, 'name');
      if (!name) continue;
      const type = (attr(tag, 'type') || 'text').toLowerCase();
      if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue;
      if (type === 'submit' || type === 'image' || type === 'button') continue;
      fields[name] = attr(tag, 'value') ?? '';
    }
    const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = selectRe.exec(inner))) {
      const name = attr(sm[1], 'name');
      if (!name) continue;
      const options = [...sm[2].matchAll(/<option\b([^>]*)>/gi)].map((o) => o[1]);
      const chosen = options.find((o) => /\bselected\b/i.test(o)) ?? options[0];
      if (chosen !== undefined) fields[name] = attr(chosen, 'value') ?? '';
    }
    const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = taRe.exec(inner))) {
      const name = attr(tm[1], 'name');
      if (name) fields[name] = decodeHtml(tm[2]);
    }
    forms.push({ action: attr(attrs, 'action'), method: (attr(attrs, 'method') || 'get').toLowerCase(), fields, html: fm[0] });
  }
  return forms;
}

/** Resolves `href` against `base` (enough for plugin use; no Node `URL` in QuickJS). */
export function resolveUrl(base: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const m = /^(https?:\/\/[^/]+)(\/[^?#]*)?/i.exec(base);
  if (!m) return href;
  if (href.startsWith('//')) return base.split(':')[0] + ':' + href;
  if (href.startsWith('/')) return m[1] + href;
  const dir = (m[2] || '/').replace(/[^/]*$/, '');
  return m[1] + dir + href;
}

/** Cookie values from a `set-cookie` header as returned by `ctx.http`. */
export function cookiesFrom(res: HttpResponse): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = res.header('set-cookie');
  if (!raw) return out;
  for (const line of raw.split('\n')) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 (also URL-safe, with or without padding) → UTF-8 text. QuickJS has no `atob`. */
export function base64Decode(input: string): string {
  const clean = input.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    buffer = (buffer << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}

/**
 * Small values a plugin keeps between calls (each call starts with a fresh JS context). They
 * live in the cookie jar under a path no real request uses, so they never go to the site.
 */
export const memo = {
  get(ctx: Ctx, site: string, key: string): string | undefined {
    const origin = /^https?:\/\/[^/]+/i.exec(site)?.[0] ?? site;
    return new RegExp(`(?:^|;\\s*)haul_${key}=([^;]*)`).exec(ctx.cookies.get(`${origin}/__haul`))?.[1];
  },
  set(ctx: Ctx, site: string, key: string, value: string, maxAgeSeconds = 86400): void {
    const origin = /^https?:\/\/[^/]+/i.exec(site)?.[0] ?? site;
    ctx.cookies.set(`${origin}/__haul`, `haul_${key}=${value}; Path=/__haul; Max-Age=${maxAgeSeconds}`);
  },
};

/**
 * Keeps at least `ms` between requests to a site, also across calls (JD's
 * setRequestIntervalLimitGlobal). Call it before each request.
 */
export async function spaceRequests(ctx: Ctx, site: string, ms: number): Promise<void> {
  const last = Number(memo.get(ctx, site, 'last') ?? 0);
  const wait = last + ms - Date.now();
  if (wait > 0) await ctx.wait(Math.min(wait, ms) / 1000);
  memo.set(ctx, site, 'last', String(Date.now()), Math.ceil(ms / 1000) + 60);
}

/** UTF-8 bytes of a string (QuickJS has no TextEncoder). */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** Lower-case hex SHA-1 of the UTF-8 text (e.g. Google's SAPISIDHASH; not for security). */
export function sha1Hex(text: string): string {
  const bytes = utf8(text);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 255);
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Array<number>(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
    }
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      [e, d, c, b, a] = [d, c, rotl(b, 30), a, t];
    }
    [h0, h1, h2, h3, h4] = [(h0 + a) | 0, (h1 + b) | 0, (h2 + c) | 0, (h3 + d) | 0, (h4 + e) | 0];
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

/** A cookie copied out of the browser. `domain` with a leading dot or `hostOnly: false` covers subdomains. */
export interface ExportedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  hostOnly?: boolean;
}

/**
 * Cookies a user copied out of the browser, the way JD's cookie login takes them: the JSON of
 * cookie extensions (Cookie-Editor, EditThisCookie: `[{ name, value, domain, path, … }]`), a
 * Netscape `cookies.txt`, or a `Cookie:` header line (`a=1; b=2`). A line `User-Agent: …` (JD
 * prefers the browser's User-Agent the cookies came from) is returned as `userAgent`.
 */
export function parseCookieExport(text: string): { cookies: ExportedCookie[]; userAgent?: string } {
  let rest = text.trim();
  let userAgent: string | undefined;
  rest = rest.replace(/^\s*User-Agent\s*:\s*(.+)$/gim, (_, ua: string) => {
    userAgent = ua.trim();
    return '';
  }).trim();
  const cookies: ExportedCookie[] = [];
  if (rest.startsWith('[') || rest.startsWith('{')) {
    let data: unknown;
    try {
      data = JSON.parse(rest);
    } catch {
      return { cookies, userAgent };
    }
    const obj = data as { cookies?: unknown; userAgent?: unknown };
    const list = Array.isArray(data) ? data : Array.isArray(obj.cookies) ? obj.cookies : [];
    if (!userAgent && typeof obj.userAgent === 'string') userAgent = obj.userAgent;
    for (const c of list as Array<Record<string, unknown>>) {
      const name = typeof c.name === 'string' ? c.name : typeof c.key === 'string' ? c.key : undefined;
      if (!name || typeof c.value !== 'string') continue;
      cookies.push({
        name,
        value: c.value,
        domain: typeof c.domain === 'string' ? c.domain : typeof c.host === 'string' ? c.host : undefined,
        path: typeof c.path === 'string' ? c.path : undefined,
        secure: c.secure === true,
        hostOnly: c.hostOnly === true,
      });
    }
    return { cookies, userAgent };
  }
  const lines = rest.split(/\r?\n/);
  if (lines.some((l) => l.split('\t').length >= 7)) {
    for (const raw of lines) {
      // `#HttpOnly_` marks HttpOnly cookies; other `#` lines are comments.
      const line = raw.replace(/^#HttpOnly_/, '');
      if (!line.trim() || line.startsWith('#')) continue;
      const f = line.split('\t');
      if (f.length < 7) continue;
      cookies.push({
        domain: f[0],
        hostOnly: f[1].toUpperCase() !== 'TRUE',
        path: f[2],
        secure: f[3].toUpperCase() === 'TRUE',
        name: f[5],
        value: f[6].trim(),
      });
    }
    return { cookies, userAgent };
  }
  for (const part of rest.replace(/^\s*Cookie\s*:\s*/i, '').split(/;\s*|\r?\n/)) {
    const i = part.indexOf('=');
    if (i > 0) cookies.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() });
  }
  return { cookies, userAgent };
}

/**
 * Puts exported cookies into the account's jar, for `defaultDomain` where the export names
 * none (a `Cookie:` line). `skip`: names to leave out (JD drops Google's many `ST-…` cookies).
 * Returns how many went in.
 */
export function importCookies(ctx: Ctx, cookies: ExportedCookie[], defaultDomain: string, skip?: RegExp): number {
  let n = 0;
  for (const c of cookies) {
    if (skip?.test(c.name) || /[;\r\n]/.test(c.name + c.value)) continue;
    const host = (c.domain ?? defaultDomain).replace(/^\./, '');
    const hostOnly = c.name.startsWith('__Host-') || (c.hostOnly && !(c.domain ?? '').startsWith('.'));
    const secure = c.secure || c.name.startsWith('__Secure-') || c.name.startsWith('__Host-');
    const attrs = [
      `${c.name}=${c.value}`,
      ...(hostOnly ? [] : [`Domain=.${host}`]),
      `Path=${c.name.startsWith('__Host-') ? '/' : c.path || '/'}`,
      ...(secure ? ['Secure'] : []),
    ];
    ctx.cookies.set(`https://${host}/`, attrs.join('; '));
    n++;
  }
  return n;
}
