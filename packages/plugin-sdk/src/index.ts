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
  /** The account's cookie jar, shared by all requests and kept across restarts. */
  cookies: {
    /** `Cookie` header value the jar would send to `url`. */
    get(url: string): string;
    /** Adds a cookie like a `Set-Cookie` header from `url` would, e.g. `a=b; Domain=.x.com; Path=/`. */
    set(url: string, cookie: string): void;
  };
}

export interface CheckResult {
  online: boolean;
  name?: string;
  size?: number;
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
}

/** One file found by `crawl`. `url` is what `check`/`resolve` get later. */
export interface CrawledFile {
  url: string;
  name?: string;
  size?: number;
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
  /** Without an account the link is not even tried. */
  accountRequired?: boolean;
  /**
   * Run calls without an account one at a time too (with an account they always are), e.g.
   * for a hoster whose API rate-limits guests (JD: getMaxConcurrentProcessingInstances = 1).
   */
  serial?: boolean;
  /** Labels and hint for the account form in the UI; plain or per UI language. */
  account?: { userLabel?: LocalizedText; secretLabel?: LocalizedText; help?: LocalizedText };
  check?(link: string, ctx: Ctx): Promise<CheckResult>;
  /**
   * Folder links: expands a link into its files when links are added (like JD's crawler).
   * Runs without an account. Links the plugin does not expand return `[link]` unchanged.
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
  constructor(kind: Kind, message: Message) {
    super(toText(message));
    this.haulKind = kind;
  }
}

/** The file is gone. The download fails without retry. */
export class OfflineError extends PluginError {
  constructor(message: Message = { de: 'Datei offline', en: 'File offline' }) {
    super('offline', message);
  }
}

/** Try again later: server busy, limit reached, maintenance. */
export class TemporaryError extends PluginError {
  constructor(message: Message) {
    super('temporary', message);
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
