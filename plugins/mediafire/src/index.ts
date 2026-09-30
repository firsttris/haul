/**
 * mediafire.com: free downloads, usually without captcha; folders expand into their files.
 *
 * References: JD's MediafireCom.java (r53182) and MediafireComFolder.java (r52758), pyLoad's
 * MediafireCom / MediafireComFolder, and mediafire_bulk_downloader for the current markup.
 *
 * - Names, sizes and folders come from the public API (`/api/1.5/file/get_info.php`,
 *   `folder/get_info.php`, `folder/get_content.php` with `chunk` paging), like JD's link check
 *   and crawler. No session token is needed for public files.
 * - The download link is on the file page: today the `downloadButton` carries it base64-encoded
 *   in `data-scrambled-url`; older pages have it in `href`, `kNO = "…"` or as plain URL.
 * - The page can ask for Mediafire's checkbox "captcha" (`mf_captcha_response=1`, no solving),
 *   rarely a reCaptcha. The IP limit (`limitReachedTTL`) sits on IP + User-Agent; JD retries
 *   with another User-Agent.
 * - A direct link (`downloadNNN.mediafire.com/…`) is tried first, like JD's stored direct URL.
 * - Account (JD MediafireCom.login / fetchAccountInfo): e-mail and password through the
 *   website's login form (`form_login1`, `security`, `login_remember`), the cookie `user` proves
 *   it; the API session token comes from `/myaccount/` and is checked with `user/get_info`.
 *   Premium (`premium: yes`, `bandwidth` = traffic left) downloads via `file/get_links`
 *   (`direct_download`) with any number of connections; a free account downloads like a guest,
 *   with its session.
 * - Password-protected files (JD handlePW / PasswordSolver, pyLoad PASSWORD_PATTERN): the page
 *   shows a password prompt; the password goes as `downloadp` in its form, sent without
 *   following redirects ("pw protected files can directly redirect to download"). If the prompt
 *   comes back, the password was wrong: three tries.
 */
import {
  AccountError,
  memo,
  base64Decode,
  CAPTCHA_FIELD,
  findCaptcha,
  HosterLimitError,
  decodeHtml,
  definePlugin,
  OfflineError,
  parseForms,
  PluginError,
  resolveUrl,
  TemporaryError,
  withPassword,
  WRONG_PASSWORD,
} from '@haul/plugin-sdk';
import type { AccountInfo, Bilingual, Ctx, CrawledFile, FileHash, HttpResponse, Resolved } from '@haul/plugin-sdk';

const SITE = 'https://www.mediafire.com';
const API = `${SITE}/api/1.5`;
const HOSTS = '(?:(?:www|app)\\.)?(?:mediafire\\.com|mfi\\.re)';
/** JD: TYPE_DIRECT. */
const DIRECT = /https?:\/\/download\d+\.mediafire(?:cdn)?\.com\/[^/\s"'<>]+\/([a-z0-9]+)\/([^/\s"'<>]+)/i;
/** Desktop User-Agents to step around the IP limit (JD: random User-Agent). */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
];
/** Folder keys are 13 characters (JD: isFolderID); file quick keys are not. */
const isFolderKey = (id: string) => /^[a-z0-9]{13}$/i.test(id);
const MAX_DEPTH = 5;

type Target = { kind: 'file'; id: string; direct?: string } | { kind: 'folder'; key: string } | { kind: 'ids'; ids: string[] };

/** Like JD's getFileIDFRomURL plus the folder and `/?id,id` forms. */
export function parseLink(link: string): Target | undefined {
  const direct = DIRECT.exec(link);
  if (direct) return { kind: 'file', id: direct[1], direct: link };
  const quick = /[?&]quickkey=([a-z0-9]+)/i.exec(link);
  if (quick) return { kind: 'file', id: quick[1] };
  const folder = /\/folder\/([a-z0-9]+)/i.exec(link) ?? /[?&]sharekey=([a-z0-9]+)/i.exec(link);
  if (folder) return { kind: 'folder', key: folder[1] };
  const file =
    /\/(?:download|file|file_premium|listen|watch|view)\/([a-z0-9]+)/i.exec(link) ??
    /\/(?:download\.php|i)\?([a-z0-9]+)/i.exec(link);
  if (file) return { kind: 'file', id: file[1] };
  const ids = /^https?:\/\/[^/]+\/\?([a-z0-9,]+)/i.exec(link);
  if (ids) {
    const list = ids[1].split(',').filter(Boolean);
    if (list.length === 1) return isFolderKey(list[0]) ? { kind: 'folder', key: list[0] } : { kind: 'file', id: list[0] };
    return { kind: 'ids', ids: list };
  }
  return undefined;
}

function target(link: string): Target {
  const t = parseLink(link);
  if (!t) {
    throw new PluginError('fatal', {
      de: `Mediafire-Link nicht erkannt: ${link}`,
      en: `Mediafire link not recognised: ${link}`,
    });
  }
  return t;
}

interface FileInfo {
  quickkey: string;
  filename?: string;
  size?: string | number;
  privacy?: string;
  password_protected?: string;
  delete_date?: string;
  /** SHA-256 of the file (JD parseFileInfo: HashInfo.parse). */
  hash?: string;
}

/** JD HashInfo.parse: the type by the length of the hex value. */
export function hashOf(f: { hash?: string }): FileHash | undefined {
  const h = (f.hash ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]+$/.test(h)) return undefined;
  const type = ({ 32: 'md5', 40: 'sha1', 64: 'sha256' } as const)[h.length as 32 | 40 | 64];
  return type ? { type, value: h } : undefined;
}

interface ApiResponse {
  result: string;
  error?: number;
  message?: string;
  file_info?: FileInfo;
  file_infos?: FileInfo[];
  folder_info?: { name?: string; file_count?: string; folder_count?: string };
  folder_content?: { files?: FileInfo[]; folders?: { folderkey: string; name?: string }[]; more_chunks?: string };
}

/** Error codes treated as "not there" (JD: 104, 110, 111, 114 → file not found). */
const NOT_FOUND = [104, 110, 111, 114];

async function api(ctx: Ctx, command: string, query: Record<string, string>): Promise<ApiResponse> {
  const qs = Object.entries({ ...query, response_format: 'json' })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  let res: HttpResponse | undefined;
  for (let i = 0; i < 3; i++) {
    res = await ctx.http.get(`${API}/${command}.php?${qs}`, {
      headers: { Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': USER_AGENTS[0] },
    });
    if (res.status !== 429 && res.status < 500) break;
    await ctx.wait(3 * (i + 1));
  }
  let body: { response?: ApiResponse };
  try {
    body = res!.json();
  } catch {
    throw new TemporaryError(`Mediafire-API: HTTP ${res!.status}`);
  }
  const r = body.response;
  if (!r) throw new TemporaryError(`Mediafire-API: HTTP ${res!.status}`);
  if (r.result === 'Error') {
    if (r.error !== undefined && NOT_FOUND.includes(r.error)) throw new OfflineError(r.message ? `Mediafire: ${r.message}` : {
      de: 'Mediafire: nicht gefunden',
      en: 'Mediafire: not found',
    });
    throw new TemporaryError(`Mediafire-API: ${r.message ?? r.error}`);
  }
  return r;
}

// ---- account (JD MediafireCom.login / apiCommand) ---------------------------------------

interface UserInfo {
  email?: string;
  premium?: string;
  bandwidth?: string | number;
}

/** An API call with the account's session token; `undefined` when the session is not valid. */
async function sessionApi(ctx: Ctx, command: string, query: Record<string, string> = {}): Promise<Record<string, unknown> | undefined> {
  const token = memo.get(ctx, SITE, 'mf_session');
  if (!token) return undefined;
  const qs = Object.entries({ ...query, session_token: token, response_format: 'json' })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const res = await ctx.http.get(`${API}/${command}.php?${qs}`, {
    headers: { Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': USER_AGENTS[0] },
  });
  let r: Record<string, unknown> | undefined;
  try {
    r = res.json<{ response?: Record<string, unknown> }>().response;
  } catch {
    throw new TemporaryError(`Mediafire-API: HTTP ${res.status}`);
  }
  if (!r) throw new TemporaryError(`Mediafire-API: HTTP ${res.status}`);
  // E.g. 105 "The supplied Session Token is expired or invalid".
  if (r.result === 'Error') return Number(r.error) === 105 ? undefined : r;
  return r;
}

/** JD login(): the saved session if it still belongs to the account, else the login form. */
async function login(ctx: Ctx): Promise<UserInfo> {
  const acc = ctx.account.get()!;
  const saved = await sessionApi(ctx, 'user/get_info');
  const known = saved?.user_info as UserInfo | undefined;
  if (known && saved?.result !== 'Error' && (known.email ?? '').toLowerCase() === acc.user.trim().toLowerCase()) return known;
  const page = await ctx.http.get(`${SITE}/login/`, { headers: { 'User-Agent': USER_AGENTS[0] } });
  const form = parseForms(page.body).find((f) => /id=["']form_login1["']/i.test(f.html));
  if (!form) throw new TemporaryError({ de: 'Mediafire: Login-Formular nicht gefunden', en: 'Mediafire: login form not found' });
  const posts = [...page.body.matchAll(/mSendDataByPostJSON\('(\/[^'"]+)'/g)].map((m) => m[1]);
  const action = form.action || (posts.length === 1 ? posts[0] : '/dynamic/client_login/mediafire.php');
  const security = /security\s*:\s*"([^"]+)/.exec(page.body)?.[1];
  const fields: Record<string, string> = { ...form.fields, login_remember: 'true', login_email: acc.user.trim(), login_pass: acc.secret };
  if (security) fields.security = security;
  await ctx.http.post(resolveUrl(page.url, action), fields, { headers: { 'User-Agent': USER_AGENTS[0], Referer: page.url } });
  // JD: "This might return an error via json but as long as we get the cookie all is fine".
  const user = /(?:^|;\s*)user=([^;]*)/.exec(ctx.cookies.get(`${SITE}/`))?.[1];
  if (!user || user.toLowerCase() === 'x') {
    throw new AccountError({ de: 'Mediafire: E-Mail oder Passwort falsch', en: 'Mediafire: wrong e-mail or password' });
  }
  const my = await ctx.http.get(`${SITE}/myaccount/`, { headers: { 'User-Agent': USER_AGENTS[0] } });
  const token =
    /parent\.bqx\("([a-f0-9]+)"\)/.exec(my.body)?.[1] ?? /LoadIframeLightbox\('\/templates\/tos\.php\?token=([a-f0-9]+)/.exec(my.body)?.[1];
  if (!token) throw new TemporaryError({ de: 'Mediafire: Session-Token nicht gefunden', en: 'Mediafire: session token not found' });
  memo.set(ctx, SITE, 'mf_session', token, 30 * 86400);
  const r = await sessionApi(ctx, 'user/get_info');
  const info = r?.user_info as UserInfo | undefined;
  if (!r || r.result === 'Error' || !info) throw new AccountError(`Mediafire: ${String(r?.message ?? 'login failed')}`);
  return info;
}

const isPremium = (u: UserInfo) => String(u.premium ?? '').toLowerCase() === 'yes';

/** JD fetchAccountInfo. */
async function accountInfo(ctx: Ctx): Promise<AccountInfo> {
  const u = await login(ctx);
  memo.set(ctx, SITE, 'mf_premium', isPremium(u) ? '1' : '0', 30 * 86400);
  if (!isPremium(u)) return { valid: true, premium: false, message: 'Free' };
  const traffic = Number(u.bandwidth);
  return { valid: true, premium: true, trafficLeft: Number.isFinite(traffic) ? traffic : undefined, message: 'Premium' };
}

/** JD handleDownload, premium: `file/get_links` with `link_type=direct_download`. */
async function resolvePremium(ctx: Ctx, quickKey: string, info?: FileInfo): Promise<Resolved | undefined> {
  let premium = memo.get(ctx, SITE, 'mf_premium');
  if (premium === undefined) {
    premium = isPremium(await login(ctx)) ? '1' : '0';
    memo.set(ctx, SITE, 'mf_premium', premium, 30 * 86400);
  }
  if (premium !== '1') return undefined;
  let r = await sessionApi(ctx, 'file/get_links', { link_type: 'direct_download', quick_key: quickKey });
  if (!r) {
    // Session expired: log in again once.
    await login(ctx);
    r = await sessionApi(ctx, 'file/get_links', { link_type: 'direct_download', quick_key: quickKey });
  }
  const link = (r?.links as Array<{ direct_download?: string; error?: string }> | undefined)?.[0];
  if (link?.direct_download) {
    return { url: link.direct_download, headers: { 'User-Agent': USER_AGENTS[0] }, name: info?.filename, size: info ? sizeOf(info) : undefined, hash: info ? hashOf(info) : undefined };
  }
  if (/User lacks permissions/i.test(link?.error ?? '')) {
    throw new PluginError('fatal', { de: 'Mediafire: dieser Account darf die Datei nicht laden', en: 'Mediafire: this account may not download the file' });
  }
  throw new TemporaryError({ de: `Mediafire: kein Premium-Link (${link?.error ?? r?.message ?? '?'})`, en: `Mediafire: no premium link (${link?.error ?? r?.message ?? '?'})` });
}

const deleted = (f: FileInfo) => !!f.delete_date && /^\d{4}-\d{2}-\d{2}/.test(f.delete_date);
const sizeOf = (f: FileInfo) => {
  const n = Number(f.size);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const fileUrl = (f: FileInfo) =>
  f.filename ? `${SITE}/file/${f.quickkey}/${encodeURIComponent(f.filename)}/file` : `${SITE}/file/${f.quickkey}`;

/** `file/get_info` for up to 100 quick keys (JD's checkLinks); keys it does not return are gone. */
async function fileInfos(ctx: Ctx, ids: string[]): Promise<Map<string, FileInfo>> {
  const out = new Map<string, FileInfo>();
  for (let i = 0; i < ids.length; i += 100) {
    let r: ApiResponse;
    try {
      r = await api(ctx, 'file/get_info', { quick_key: ids.slice(i, i + 100).join(',') });
    } catch (e) {
      // All requested keys unknown.
      if (e instanceof OfflineError) continue;
      throw e;
    }
    for (const f of r.file_infos ?? (r.file_info ? [r.file_info] : [])) out.set(f.quickkey, f);
  }
  return out;
}

/** Files of a folder and its subfolders (JD's crawlFolder with `chunk` paging). */
async function walkFolder(ctx: Ctx, key: string, files: CrawledFile[], depth: number): Promise<string | undefined> {
  const info = await api(ctx, 'folder/get_info', { folder_key: key });
  const name = info.folder_info?.name;
  if (depth > MAX_DEPTH) return name;
  for (const type of ['files', 'folders'] as const) {
    for (let chunk = 1; chunk < 1000; chunk++) {
      const r = await api(ctx, 'folder/get_content', { folder_key: key, content_type: type, chunk: String(chunk) });
      const content = r.folder_content ?? {};
      for (const f of content.files ?? []) {
        if (deleted(f)) continue;
        files.push({ url: fileUrl(f), name: f.filename, size: sizeOf(f), hash: hashOf(f) });
      }
      for (const sub of content.folders ?? []) await walkFolder(ctx, sub.folderkey, files, depth + 1);
      if (content.more_chunks !== 'yes') break;
    }
  }
  return name;
}

/** JD's handleNonAPIErrors: `errno` in the URL, repair and maintenance pages, IP limit. */
function pageErrors(res: HttpResponse) {
  const errno = /[?&]errno=(\d+)/.exec(res.url)?.[1];
  if (errno) {
    const gone: Record<string, Bilingual> = {
      '320': { de: 'vom Uploader oder Mediafire entfernt', en: 'removed by the uploader or Mediafire' },
      '323': { de: 'als gefährlich blockiert', en: 'blocked as dangerous' },
      '326': {
        de: 'von Google Safe Browsing als gefährlich erkannt',
        en: 'flagged as dangerous by Google Safe Browsing',
      },
      '378': { de: 'wegen Regelverstoß entfernt', en: 'removed for a terms violation' },
      '380': { de: 'per DMCA entfernt', en: 'removed by a DMCA request' },
      '382': { de: 'Account des Uploaders gesperrt', en: 'the uploader’s account is suspended' },
      '386': { de: 'wegen Regelverstoß blockiert', en: 'blocked for a terms violation' },
      '388': { de: 'als urheberrechtlich geschützt erkannt', en: 'identified as copyrighted work' },
    };
    const g = gone[errno];
    if (g) throw new OfflineError({ de: `Mediafire: ${g.de}`, en: `Mediafire: ${g.en}` });
    if (errno === '394') throw new PluginError('fatal', {
        de: 'Mediafire: verschlüsseltes Archiv, Download-Limit des Uploaders erreicht',
        en: 'Mediafire: encrypted archive, the uploader’s download limit is reached',
      });
    if (errno === '999') {
      throw new PluginError('fatal', {
        de: 'Mediafire: privat, nur der Besitzer kann laden',
        en: 'Mediafire: private, only the owner can download',
      });
    }
    throw new PluginError('fatal', { de: `Mediafire: Fehlercode ${errno}`, en: `Mediafire: error code ${errno}` });
  }
  if (/download_repair\.php/i.test(res.url)) {
    throw new TemporaryError({
      de: 'Mediafire erzeugt einen neuen Download-Schlüssel',
      en: 'Mediafire is generating a new download key',
    });
  }
  const html = res.body;
  if (/class="error-title">\s*Temporarily Unavailable\s*<\/p>/i.test(html)) {
    throw new TemporaryError({
      de: 'Mediafire: Datei vorübergehend nicht verfügbar',
      en: 'Mediafire: file temporarily unavailable',
    });
  }
  if (/class="error-title"[^>]*>\s*This download is currently unavailable\s*</i.test(html)) {
    throw new TemporaryError({
      de: 'Mediafire: Download gerade nicht verfügbar',
      en: 'Mediafire: download currently unavailable',
    });
  }
  const ttl = limitTtl(html);
  if (ttl) {
    // JD: ERROR_IP_BLOCKED with limitReachedTTL seconds.
    throw new HosterLimitError(
      {
        de: `Mediafire: Download-Limit dieser IP erreicht (${ttl} s)`,
        en: `Mediafire: download limit of this IP reached (${ttl} s)`,
      },
      Number(ttl) || 60 * 60,
    );
  }
}

const limitTtl = (html: string) => /var limitReachedTTL = (\d+);/.exec(html)?.[1];

/** JD handlePW: the page asks for the file's password. */
const PASSWORD_PROMPT = /aria-labelledby\s*=\s*"passwordmsg"|class\s*=\s*"passwordPrompt"|<form name="form_password"/i;

/**
 * JD getPasswordForm: the form with the prompt, else the form "download" with a `downloadp`
 * field; pyLoad's form "form_password" and any form with `downloadp` also count.
 */
export function passwordForm(html: string) {
  const forms = parseForms(html);
  return (
    forms.find((f) => PASSWORD_PROMPT.test(f.html)) ??
    forms.find((f) => /name=["'](?:download|form_password)["']/i.test(f.html) && 'downloadp' in f.fields) ??
    forms.find((f) => 'downloadp' in f.fields)
  );
}

/** The download link on a file page, in the order the current and older layouts use. */
export function findDownloadLink(html: string): string | undefined {
  const button = /<a\b[^>]*\bid="downloadButton"[^>]*>/i.exec(html)?.[0] ?? /<a\b[^>]*aria-label="Download file"[^>]*>/i.exec(html)?.[0];
  if (button) {
    const scrambled = /data-scrambled-url="([^"]+)"/i.exec(button)?.[1];
    if (scrambled) {
      const url = base64Decode(scrambled).trim();
      if (/^https?:\/\//i.test(url)) return url;
    }
    const href = /\bhref="(https?:\/\/[^"]+)"/i.exec(button)?.[1];
    if (href) return decodeHtml(href);
  }
  const kno = /kNO\s*=\s*"(https?:\/\/[^"]+)"/i.exec(html)?.[1];
  if (kno) return kno;
  const scrambled = /data-scrambled-url\s*=\s*"([^"]+)"/i.exec(html)?.[1];
  if (scrambled) {
    const url = base64Decode(scrambled).trim();
    if (/^https?:\/\//i.test(url)) return url;
  }
  return DIRECT.exec(html)?.[0];
}

async function directLinkWorks(ctx: Ctx, url: string, ua: string): Promise<boolean> {
  try {
    const res = await ctx.http.request({ method: 'HEAD', url, headers: { 'User-Agent': ua }, timeoutMs: 20000 });
    return res.ok() && res.file;
  } catch {
    return false;
  }
}

function download(url: string, ua: string, referer: string) {
  // JD: getMaxChunks() = -15 without account.
  return { url, headers: { 'User-Agent': ua, Referer: referer }, maxConnections: 15 };
}

export default definePlugin({
  id: 'mediafire',
  name: 'Mediafire',
  version: 6,
  domains: ['mediafire.com', 'mfi.re'],
  matches: [new RegExp(`^https?://${HOSTS}/.+`, 'i'), /^https?:\/\/download\d+\.mediafire(?:cdn)?\.com\//i],
  accountRequired: false,
  account: {
    userLabel: { de: 'E-Mail', en: 'E-mail' },
    secretLabel: { de: 'Passwort', en: 'Password' },
    help: {
      de: 'Wie bei JDownloader: E-Mail und Passwort des Mediafire-Accounts. Premium lädt über den Direktlink der API, ein Free-Account wie ohne Account.',
      en: 'Like JDownloader: the Mediafire account\'s e-mail and password. Premium downloads through the API\'s direct link, a free account like without one.',
    },
  },

  async checkAccount(ctx) {
    return accountInfo(ctx);
  },

  async crawl(link, ctx) {
    const t = target(link);
    const files: CrawledFile[] = [];
    if (t.kind === 'folder') {
      const packageName = await walkFolder(ctx, t.key, files, 0);
      return { packageName, files };
    }
    const ids = t.kind === 'ids' ? t.ids : [t.id];
    const folders = ids.filter(isFolderKey);
    const infos = await fileInfos(ctx, ids.filter((id) => !isFolderKey(id)));
    if (t.kind === 'file') {
      const f = infos.get(t.id);
      if (!f || deleted(f)) {
        throw new OfflineError({
          de: 'Mediafire: Datei nicht gefunden',
          en: 'Mediafire: file not found',
        });
      }
      return { files: [{ url: t.direct ?? link, name: f.filename, size: sizeOf(f), hash: hashOf(f) }] };
    }
    for (const f of infos.values()) if (!deleted(f)) files.push({ url: fileUrl(f), name: f.filename, size: sizeOf(f), hash: hashOf(f) });
    for (const key of folders) await walkFolder(ctx, key, files, 1);
    return { files };
  },

  async check(link, ctx) {
    const t = target(link);
    if (t.kind !== 'file') {
      if (t.kind === 'folder') await api(ctx, 'folder/get_info', { folder_key: t.key });
      return { online: true };
    }
    const f = (await fileInfos(ctx, [t.id])).get(t.id);
    if (!f || deleted(f)) return { online: false };
    return { online: true, name: f.filename, size: sizeOf(f), hash: hashOf(f) };
  },

  async resolve(link, ctx) {
    const t = target(link);
    if (t.kind !== 'file') {
      throw new PluginError('fatal', {
        de: 'Mediafire: Ordner-Link, bitte neu hinzufügen',
        en: 'Mediafire: folder link, please add it again',
      });
    }
    if (t.direct && (await directLinkWorks(ctx, t.direct, USER_AGENTS[0]))) {
      return download(t.direct, USER_AGENTS[0], SITE + '/');
    }
    const info = (await fileInfos(ctx, [t.id])).get(t.id);
    if (!info || deleted(info)) {
      throw new OfflineError({
        de: 'Mediafire: Datei nicht gefunden',
        en: 'Mediafire: file not found',
      });
    }
    // Premium account: the API's direct link (JD); a private file may belong to the account.
    if (ctx.account.get()) {
      const premium = await resolvePremium(ctx, t.id, info);
      if (premium) return premium;
    }
    if (info.privacy && info.privacy !== 'public') {
      throw new PluginError('fatal', {
        de: 'Mediafire: private Datei, nur mit Berechtigung ladbar',
        en: 'Mediafire: private file, only downloadable with permission',
      });
    }
    const pageUrl = `${SITE}/file/${t.id}`;
    let ua = USER_AGENTS[0];
    let res = await ctx.http.get(pageUrl, { headers: { 'User-Agent': ua } });
    // Hotlinked file (JD: "Found hotlinked item").
    if (res.file) return { ...download(res.url, ua, pageUrl), name: info.filename, size: sizeOf(info), hash: hashOf(info) };
    // JD: the IP limit sits on IP + User-Agent; another User-Agent often gets around it.
    for (let i = 1; i < USER_AGENTS.length && limitTtl(res.body); i++) {
      ua = USER_AGENTS[i];
      await ctx.wait(2);
      res = await ctx.http.get(pageUrl, { headers: { 'User-Agent': ua } });
    }
    // Mediafire's own checkbox "captcha" needs no solving; a reCaptcha does.
    for (let i = 0; i < 3; i++) {
      const form = parseForms(res.body).find((f) => /name="form_captcha"/i.test(f.html));
      if (!form) break;
      const fields: Record<string, string> = { ...form.fields };
      const widget = findCaptcha(form.html) ?? findCaptcha(res.body);
      if (widget) {
        // JD: reCaptchaV2 in form_captcha; the user solves it in the browser on mediafire.com.
        fields[CAPTCHA_FIELD[widget.kind]] = await ctx.captcha.solve({ kind: widget.kind, siteKey: widget.siteKey, pageUrl: res.url });
      } else if (/customCaptchaCheckbox/i.test(form.html)) {
        fields.mf_captcha_response = '1';
      } else {
        throw new PluginError('fatal', {
          de: 'Mediafire: unbekanntes Captcha',
          en: 'Mediafire: unknown captcha',
        });
      }
      res = await ctx.http.post(resolveUrl(res.url, form.action || res.url), fields, {
        headers: { 'User-Agent': ua, Referer: res.url },
      });
      if (res.file) return { ...download(res.url, ua, pageUrl), name: info.filename, size: sizeOf(info), hash: hashOf(info) };
    }
    if (PASSWORD_PROMPT.test(res.body)) {
      let page = res;
      const unlocked = await withPassword(ctx, 'Mediafire', async (password): Promise<{ direct: string } | { page: HttpResponse } | typeof WRONG_PASSWORD> => {
        const form = passwordForm(page.body);
        // pyLoad: without a form, `downloadp` goes to the file page.
        const answer = await ctx.http.post(
          resolveUrl(page.url, form?.action || page.url),
          { ...(form?.fields ?? {}), downloadp: password },
          { headers: { 'User-Agent': ua, Referer: page.url }, followRedirects: false },
        );
        let next = answer;
        const location = answer.status >= 300 && answer.status < 400 ? answer.header('location') : null;
        if (location) {
          const target = resolveUrl(page.url, location);
          if (DIRECT.test(target)) return { direct: target };
          // A redirect to a page (usually the file page, now unlocked): load it.
          next = await ctx.http.get(target, { headers: { 'User-Agent': ua, Referer: page.url } });
        }
        if (next.file) return { direct: next.url };
        if (PASSWORD_PROMPT.test(next.body)) {
          page = next;
          return WRONG_PASSWORD;
        }
        return { page: next };
      });
      if ('direct' in unlocked) return { ...download(unlocked.direct, ua, pageUrl), name: info.filename, size: sizeOf(info), hash: hashOf(info) };
      res = unlocked.page;
    }
    if (/class="MalwareAdvisory"/i.test(res.body)) {
      throw new PluginError('fatal', {
        de: 'Mediafire: Datei als Schadsoftware markiert',
        en: 'Mediafire: the file is flagged as malware',
      });
    }
    const url = findDownloadLink(res.body);
    if (!url) {
      pageErrors(res);
      throw new PluginError('fatal', {
        de: `Mediafire: Download-Link nicht gefunden (${res.url})`,
        en: `Mediafire: download link not found (${res.url})`,
      });
    }
    return { ...download(url, ua, res.url), name: info.filename, size: sizeOf(info), hash: hashOf(info) };
  },
});
