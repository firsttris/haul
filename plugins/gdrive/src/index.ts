/**
 * Google Drive: public files without an account, the way JD's website mode does it.
 *
 * Reference: JD's GoogleDrive.java (r53450, mirror 2026-09-28). pyLoad uses the Drive API with
 * pyLoad's own API key instead; that key is not ours to use, so Haul follows JD.
 *
 * - "Quick linkcheck" (JD handleLinkcheckQuick): `POST drive.google.com/uc?id=…&authuser=0&
 *   export=download` with an empty body and `X-Drive-First-Party: DriveViewer` answers
 *   `)]}'` + JSON with fileName, sizeBytes, downloadUrl, scanResult and disposition.
 * - Download: the downloadUrl; for files too big for Google's virus scan the answer is a page
 *   with a confirm link or the form `download-form` (JD findConfirmDownloadurlForm).
 * - Errors (JD handleErrorsWebsite): quota ("Too many users have viewed or downloaded this file
 *   recently", JD waits 60 min), rate limit (429, 5 min), "automated queries" (5 min), infected
 *   files, private files (403, accounts.google.com).
 * - Folders (JD GoogleDriveCrawler.crawlWebsite, r53450, as JD does it without an own API key):
 *   the folder page gives the web API key (`"<6 chars><rest>","<same 6 chars>…",null`), the
 *   team drive id (in `_DRIVE_ivd`) and the title; the items come from
 *   `clients6.google.com/drive/v2beta/files` (50 per page, `pageToken`), with the headers of
 *   GoogleHelper.prepBrowserWebAPI. Shortcuts point to their target, subfolders are listed too
 *   (their files join the package), `open?id=` links are file or folder depending on the redirect.
 * - Google account (JD COOKIE_LOGIN_ONLY, GoogleHelper.login): Google has no password login
 *   for programs, so the account is the browser's exported cookies (Cookie-Editor JSON,
 *   cookies.txt or a `Cookie:` line), without the many `ST-…` cookies (JD loadUserCookies), with
 *   the browser's User-Agent if the export has a `User-Agent:` line (JD prefers it). The check
 *   (JD validateCookiesGoogleDrive): `drive.google.com/drive/my-drive` must not end up at
 *   accounts.google.com, and the cookie `SAPISID` must be there (JD errorIncompleteLogin).
 *   Logged in, every request carries the cookies (the jar keeps what Google renews), the folder
 *   API gets `Authorization: SAPISIDHASH <time>_<sha1(time SAPISID origin)>` and
 *   `X-Goog-Authuser: 0` (JD prepBrowserWebAPI), the fallback download URL is `/u/0/uc`
 *   (JD constructFileDirectDownloadUrl). Folders are listed with the account too.
 * - Google documents (JD parseGoogleDocumentPropertiesAPIAndSetFilename): the quick check gives
 *   size 0; the file page (JD handleLinkcheckFileOverview) gives the web API key, the file's
 *   details (`v2beta/files/<id>`, logged in `v2internal`) its type and `exportLinks`. The format:
 *   JD's AUTO first (the title names an available one, e.g. "Bericht.pdf"), then, unlike JD's
 *   default ZIP of HTML pages, what Google Drive's own "Download" gives (Word, PowerPoint,
 *   Excel), then JD's fallback pdf, odt, ods, txt, and last JD's ZIP export.
 * - Not yet: video streams.
 */
import {
  AccountError,
  decodeHtml,
  definePlugin,
  HosterLimitError,
  importCookies,
  OfflineError,
  parseCookieExport,
  parseForms,
  PluginError,
  resolveUrl,
  sha1Hex,
  TemporaryError,
} from '@haul/plugin-sdk';
import type { CrawledFile, Ctx, FileHash, HttpResponse } from '@haul/plugin-sdk';

const HOSTS = '(?:drive|docs|drive\\.usercontent)\\.google\\.com';
/** JD getAnnotationUrls: file links and Google Docs documents (`document/d/`). */
const LINK = new RegExp(
  `^https?://${HOSTS}/(?:(?:leaf|open)\\?(?:[^"<>/]*?&)?id=[A-Za-z0-9_-]+|(?:u/\\d+/)?uc\\?(?:[^"<>]*?&)?id=[A-Za-z0-9_-]+|download\\?(?:[^"<>]*?&)?id=[A-Za-z0-9_-]+|(?:a/[a-zA-Z0-9.]+/)?(?:file|document)/d/[A-Za-z0-9_-]+)`,
  'i',
);
/** JD GoogleDriveCrawler: PATTERN_FOLDER_NORMAL, PATTERN_FOLDERVIEW, PATTERN_FOLDER_CURRENT. */
const FOLDER = new RegExp(
  `^https?://(?:drive|docs)\\.google\\.com/(?:folder/d/[A-Za-z0-9_-]+|(?:embedded)?folderview\\?[^#]*id=[A-Za-z0-9_-]+|[^?#]*/folders/[A-Za-z0-9_-]+)`,
  'i',
);
/** JD PATTERN_REDIRECT: a file or a folder. */
const OPEN = /^https?:\/\/(?:drive|docs)\.google\.com\/open\?id=[A-Za-z0-9_-]+/i;
const HEADERS = { 'Accept-Language': 'en-gb, en;q=0.9' };
/** JD getMaxChunks: -6 (2025-05-02). */
const CONNECTIONS = 6;
/** JD getWaitOnQuotaReachedMinutes default and getRateLimitWaittime. */
const QUOTA_WAIT = 60 * 60;
const RATE_WAIT = 5 * 60;

const DRIVE = 'https://drive.google.com';
/** JD GoogleHelper.loadUserCookies: "not required but there can be MANY of them". */
const SKIP_COOKIES = /^ST-/;

/**
 * The Google account's cookies into the jar, unless it has them already (it keeps what Google
 * renews; new account data drop the jar). The headers for this call: the browser's User-Agent
 * from the export, if any. Without an account: the plain headers.
 */
function login(ctx: Ctx): Record<string, string> {
  const acc = ctx.account.get();
  if (!acc) return HEADERS;
  const { cookies, userAgent } = parseCookieExport(acc.secret);
  if (!sapisid(ctx)) {
    if (!cookies.length) {
      throw new AccountError({
        de: 'Google Drive: in den Account-Daten keine Cookies erkannt (JSON-Export, cookies.txt oder „Cookie: …“)',
        en: 'Google Drive: no cookies found in the account data (JSON export, cookies.txt or “Cookie: …”)',
      });
    }
    importCookies(ctx, cookies, 'google.com', SKIP_COOKIES);
  }
  return userAgent ? { ...HEADERS, 'User-Agent': userAgent } : HEADERS;
}

function sapisid(ctx: Ctx): string | undefined {
  return /(?:^|;\s*)SAPISID=([^;]+)/.exec(ctx.cookies.get(`${DRIVE}/`))?.[1];
}

/** JD GoogleHelper.prepBrowserWebAPI for logged-in users. */
export function authHeaders(ctx: Ctx, now = Date.now()): Record<string, string> {
  const sid = ctx.account.get() ? sapisid(ctx) : undefined;
  if (!sid) return {};
  const ts = Math.floor(now / 1000);
  return { Authorization: `SAPISIDHASH ${ts}_${sha1Hex(`${ts} ${sid} ${DRIVE}`)}`, 'X-Goog-Authuser': '0' };
}

/** JD errorAccountRequiredOrPrivateFile: without an account "add one", with one "no access". */
function privateError(ctx: Ctx, what: 'file' | 'folder'): PluginError {
  const [de, en] = what === 'file' ? ['private Datei', 'private file'] : ['privater Ordner', 'private folder'];
  return new PluginError(
    'fatal',
    ctx.account.get()
      ? { de: `Google Drive: ${de}, dieses Google-Konto hat keinen Zugriff`, en: `Google Drive: ${en}, this Google account has no access` }
      : { de: `Google Drive: ${de}, nur mit Google-Account mit Berechtigung`, en: `Google Drive: ${en}, only with a Google account that has access` },
  );
}

/** File id and resource key (JD getFID / getFileResourceKey). */
export function parseLink(link: string): { id: string; resourceKey?: string } | undefined {
  const id =
    /\/(?:file|document)\/d\/([A-Za-z0-9_-]+)/i.exec(link)?.[1] ??
    /[?&]id=([A-Za-z0-9_-]+)/i.exec(link)?.[1];
  if (!id || !LINK.test(link)) return undefined;
  const resourceKey = /[?&]resourcekey=([^&#]+)/i.exec(link)?.[1];
  return { id, resourceKey: resourceKey ? decodeURIComponent(resourceKey) : undefined };
}

interface Quick {
  fileName?: string;
  sizeBytes?: number;
  downloadUrl?: string;
  scanResult?: string;
  disposition?: string;
}

function target(link: string) {
  if (folderOf(link)) {
    throw new PluginError('fatal', { de: 'Google Drive: Ordner-Link, bitte neu hinzufügen', en: 'Google Drive: folder link, please add it again' });
  }
  const t = parseLink(link);
  if (!t) throw new PluginError('fatal', { de: `kein Google-Drive-Datei-Link: ${link}`, en: `not a Google Drive file link: ${link}` });
  return t;
}

/** JD handleErrorsWebsite and checkErrorBlockedByGoogle, for pages instead of the file. */
export function pageErrors(ctx: Ctx, res: HttpResponse): void {
  const html = res.body;
  if (res.status === 429) {
    throw new TemporaryError({ de: 'Google Drive: Rate-Limit', en: 'Google Drive: rate limited' }, RATE_WAIT);
  }
  if (res.status === 403 && /but your computer or network may be sending automated queries/i.test(html)) {
    // JD checkErrorBlockedByGoogle: ERROR_IP_BLOCKED.
    throw new HosterLimitError({ de: 'Google Drive: von Google blockiert (automatische Anfragen)', en: 'Google Drive: blocked by Google (automated queries)' }, RATE_WAIT);
  }
  if (/>\s*Sorry, this file is infected with a virus/i.test(html)) {
    throw new PluginError('fatal', {
      de: 'Google Drive: Datei laut Google mit Virus infiziert, nur der Besitzer kann sie laden',
      en: 'Google Drive: file infected according to Google, only the owner can download it',
    });
  }
  if (
    /error-subcaption">Too many users have viewed or downloaded this file recently|<title>Google Drive – (?:Quota|Cuota|Kuota|La quota|Quote)/i.test(html)
  ) {
    throw new TemporaryError(
      { de: 'Google Drive: Download-Kontingent der Datei erschöpft, später erneut', en: 'Google Drive: download quota of the file exceeded, trying later' },
      QUOTA_WAIT,
    );
  }
  if (/^https?:\/\/accounts\.google\.com\//i.test(res.url) || res.status === 401 || res.status === 403) {
    throw privateError(ctx, 'file');
  }
}

/** JD findFolderID: the second id of `/folders/<root>/<sub>` wins. */
export function folderOf(link: string): { id: string; resourceKey?: string } | undefined {
  if (!FOLDER.test(link)) return undefined;
  const id =
    /\/folder\/d\/([A-Za-z0-9_-]+)/i.exec(link)?.[1] ??
    (() => {
      const m = /\/folders\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?/i.exec(link);
      return m ? (m[2] ?? m[1]) : undefined;
    })() ??
    /[?&]id=([^&=#]+)/i.exec(link)?.[1];
  if (!id) return undefined;
  const key = /[?&]resourcekey=([^&#]+)/i.exec(link)?.[1];
  return { id, resourceKey: key ? decodeURIComponent(key) : undefined };
}

/** JD generateFolderURL / generateFileURL. */
const folderUrl = (id: string, key?: string) => `https://drive.google.com/drive/folders/${id}${key ? `?resourcekey=${key}` : ''}`;
const fileUrl = (id: string, key?: string) => `https://drive.google.com/file/d/${id}${key ? `?resourcekey=${key}` : ''}`;

/** JD Encoding.unicodeDecode: `\xNN` and `\uNNNN` escapes. */
function unescapeJs(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})/g, (_, x, u) => String.fromCharCode(parseInt(x ?? u, 16)));
}

/** JD getCurrentFolderTitleWebsite. */
export function folderTitle(html: string): string | undefined {
  const raw = /"title":"([^"]+)","urlPrefix"/.exec(html)?.[1] ?? /<title>([^<]+)<\/title>/i.exec(html)?.[1];
  if (!raw) return undefined;
  // JD strips " - ", " – " and " – " (no-break space) variants of the suffix.
  const title = decodeHtml(unescapeJs(raw)).trim().replace(/[\s\u00a0][-–][\s\u00a0]Google Drive$/, '');
  return title || undefined;
}

/** What the folder page gives for the listing: JD's key and teamDriveID regexes. */
export function webApiInfo(html: string): { key?: string; teamDriveId?: string } {
  const k = /"([A-Za-z0-9\-_]{6})([A-Za-z0-9\-_]+)"\s*,\s*"\1[A-Za-z0-9\-_]+"\s*,\s*null/.exec(html);
  let ivd = /window\['_DRIVE_ivd'\]\s*=\s*'\[(.*?)';/.exec(html)?.[1];
  if (ivd === undefined) {
    const hex = /window\['_DRIVE_ivd'\]\s*=\s*'(.*?)';/.exec(html)?.[1];
    if (hex !== undefined) ivd = unescapeJs(hex);
  }
  const teamDriveId = ivd ? /,null,\d{10,},\d+,"([A-Za-z0-9_\-]{10,30})",null,null/.exec(ivd)?.[1] : undefined;
  return { key: k ? k[1] + k[2] : undefined, teamDriveId };
}

interface DriveItem {
  kind?: string;
  id: string;
  title?: string;
  mimeType?: string;
  fileSize?: string | number;
  resourceKey?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  md5Checksum?: string;
  sha256Checksum?: string;
}

/** JD parseFileInfoAPIAndWebsiteWebAPI: the file's hashes, SHA-256 before MD5. */
export function driveHash(item: DriveItem): FileHash | undefined {
  const sha = (item.sha256Checksum ?? '').toLowerCase();
  if (/^[a-f0-9]{64}$/.test(sha)) return { type: 'sha256', value: sha };
  const md5 = (item.md5Checksum ?? '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(md5) ? { type: 'md5', value: md5 } : undefined;
}

/** JD getSingleFilesFieldsWebsite. */
const FIELDS =
  'kind,mimeType,id,title,fileSize,description,md5Checksum,sha256Checksum,exportLinks,capabilities(canDownload),resourceKey,modifiedDate,shortcutDetails(targetId,targetMimeType),ownerNames';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Subfolders are followed this deep. */
const MAX_DEPTH = 5;

/** JD crawlWebsite: the folder page (errors, title, key), then the items of all pages. */
async function crawlFolder(ctx: Ctx, start: { id: string; resourceKey?: string }, base: Record<string, string>) {
  const page = await ctx.http.get(folderUrl(start.id, start.resourceKey), { headers: base });
  if (page.status === 404) throw new OfflineError({ de: 'Google Drive: Ordner nicht gefunden', en: 'Google Drive: folder not found' });
  if (/^https?:\/\/accounts\.google\.com\//i.test(page.url) || page.status === 403) {
    throw privateError(ctx, 'folder');
  }
  if (page.status === 429) {
    throw new HosterLimitError({ de: 'Google Drive: Rate-Limit', en: 'Google Drive: rate limited' }, RATE_WAIT);
  }
  // A shortcut redirects to another folder (JD: "Folder redirected to new folder").
  const root = folderOf(page.url) ?? start;
  const { key, teamDriveId } = webApiInfo(page.body);
  if (!key) {
    throw new TemporaryError({ de: 'Google Drive: Schlüssel für die Ordnerliste nicht gefunden', en: 'Google Drive: key for the folder listing not found' });
  }
  const files: CrawledFile[] = [];
  const seen = new Set<string>([root.id]);
  const walk = async (folder: { id: string; resourceKey?: string }, depth: number) => {
    const query = [
      'openDrive=false',
      'reason=102',
      'syncType=0',
      'errorRecovery=false',
      `q=${encodeURIComponent(`trashed = false and '${folder.id}' in parents`)}`,
      `fields=${encodeURIComponent(`kind,nextPageToken,incompleteSearch,items(${FIELDS})`)}`,
      'appDataFilter=NO_APP_DATA',
      'spaces=drive',
      'maxResults=50',
      'orderBy=folder%2Ctitle_natural%20asc',
      'retryCount=0',
      `key=${key}`,
      ...(folder.resourceKey ? [`resourcekey=${folder.resourceKey}`] : []),
      'supportsTeamDrives=true',
      ...(teamDriveId ? ['includeTeamDriveItems=true', `teamDriveId=${teamDriveId}`, 'corpora=teamDrive'] : []),
    ];
    const headers: Record<string, string> = {
      ...base,
      ...authHeaders(ctx),
      Accept: '*/*',
      Origin: 'https://drive.google.com',
      Referer: 'https://drive.google.com/',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Javascript-User-Agent': 'google-api-javascript-client/1.1.0',
      ...(folder.resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${folder.id}/${folder.resourceKey}` } : {}),
    };
    const subfolders: Array<{ id: string; resourceKey?: string }> = [];
    let token: string | undefined;
    for (let n = 0; ; n++) {
      const url = `https://clients6.google.com/drive/v2beta/files?${query.join('&')}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
      const res = await ctx.http.get(url, { headers });
      if (res.status === 429) {
        throw new HosterLimitError({ de: 'Google Drive: Rate-Limit', en: 'Google Drive: rate limited' }, RATE_WAIT);
      }
      let data: { items?: DriveItem[]; nextPageToken?: string };
      try {
        data = res.json();
      } catch {
        data = {};
      }
      if (!Array.isArray(data.items)) {
        throw new TemporaryError({
          de: `Google Drive: Ordnerliste nicht lesbar (HTTP ${res.status})`,
          en: `Google Drive: folder listing not readable (HTTP ${res.status})`,
        });
      }
      let fresh = 0;
      for (const item of data.items) {
        // JD: a shortcut stands for its target.
        const id = item.shortcutDetails?.targetId ?? item.id;
        const mime = item.shortcutDetails?.targetMimeType ?? item.mimeType;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        fresh++;
        if ((item.kind ?? '').toLowerCase() === 'drive#file' && mime !== FOLDER_MIME) {
          const size = Number(item.fileSize);
          files.push({ url: fileUrl(id, item.resourceKey), name: item.title, size: size > 0 ? size : undefined, hash: driveHash(item) });
        } else {
          subfolders.push({ id, resourceKey: item.resourceKey });
        }
      }
      token = data.nextPageToken;
      if (!token || !data.items.length || !fresh) break;
      // JD: sleep(500) between pages.
      await ctx.wait(0.5);
    }
    if (depth >= MAX_DEPTH) return;
    for (const sub of subfolders) await walk(sub, depth + 1);
  };
  await walk(root, 0);
  return { packageName: folderTitle(page.body), files };
}

/** JD PATTERN_REDIRECT: follows `open?id=` until it is a file or a folder link. */
async function openTarget(ctx: Ctx, link: string, headers: Record<string, string>): Promise<string> {
  let url = link.replace(/^http:/i, 'https:');
  for (let i = 0; i <= 3; i++) {
    const res = await ctx.http.get(url, { headers, followRedirects: false });
    const location = res.status >= 300 && res.status < 400 ? res.header('location') : null;
    // JD: no redirect on the first request → offline.
    if (!location) throw new OfflineError({ de: 'Google Drive: Link nicht gefunden', en: 'Google Drive: link not found' });
    url = resolveUrl(url, location);
    if (!OPEN.test(url) && (FOLDER.test(url) || LINK.test(url))) return url;
  }
  throw new TemporaryError({ de: 'Google Drive: zu viele Weiterleitungen', en: 'Google Drive: too many redirects' });
}

/** JD handleLinkcheckQuick. */
async function quickCheck(ctx: Ctx, id: string, resourceKey: string | undefined, headers: Record<string, string>): Promise<Quick> {
  const q = [`id=${encodeURIComponent(id)}`];
  if (resourceKey) q.push(`resourcekey=${encodeURIComponent(resourceKey)}`);
  // JD: "authuser=0 also for logged-in users!"
  q.push('authuser=0', 'export=download');
  const res = await ctx.http.post(`https://drive.google.com/uc?${q.join('&')}`, '', {
    headers: { ...headers, 'X-Drive-First-Party': 'DriveViewer' },
  });
  if (res.status === 404) throw new OfflineError({ de: 'Google Drive: Datei nicht gefunden', en: 'Google Drive: file not found' });
  if (res.status === 403) throw privateError(ctx, 'file');
  pageErrors(ctx, res);
  const json = /(\{[\s\S]+\})\s*$/.exec(res.body)?.[1];
  if (!json) throw new TemporaryError({ de: `Google Drive: unerwartete Antwort (HTTP ${res.status})`, en: `Google Drive: unexpected answer (HTTP ${res.status})` });
  return JSON.parse(json) as Quick;
}

/** JD handleLinkcheckFileOverview: the web API key on the file page. */
export function fileApiKey(html: string): string | undefined {
  return /"([^"]+)",null,"\/drive\/v2beta"/.exec(html)?.[1] ?? /"\/drive\/v2internal","([^"]+)"/.exec(html)?.[1];
}

/** Google Drive's own download format per document type (its "Download" menu). */
const OFFICE: Record<string, string> = { document: 'docx', presentation: 'pptx', spreadsheet: 'xlsx' };
/** JD fileExtFallbackPriorityList. */
const FALLBACK = ['pdf', 'odt', 'ods', 'txt'];

/**
 * The export of a Google document: its URL and file extension (JD
 * parseGoogleDocumentPropertiesAPIAndSetFilename, see the top of the file), or JD's ZIP export
 * when no known format is offered.
 */
export function chooseExport(id: string, title: string, mimeType: string | undefined, exportLinks: Record<string, string> | undefined): { url: string; ext: string } {
  const byExt = new Map<string, string>();
  for (const url of Object.values(exportLinks ?? {})) {
    const fmt = /[?&]exportFormat=([^&#]+)/i.exec(url)?.[1]?.toLowerCase();
    if (!fmt) continue;
    byExt.set(fmt, url);
    // JD: "Small workaround for markdown".
    if (fmt === 'markdown') byExt.set('md', url);
  }
  const type = /^application\/vnd\.google-apps\.(.+)$/i.exec(mimeType ?? '')?.[1]?.toLowerCase();
  const own = /\.([A-Za-z0-9]{2,5})$/.exec(title)?.[1]?.toLowerCase();
  for (const ext of [own, type ? OFFICE[type] : undefined, ...FALLBACK]) {
    const url = ext ? byExt.get(ext) : undefined;
    if (ext && url) return { url, ext };
  }
  return { url: `https://docs.google.com/feeds/download/documents/export/Export?id=${encodeURIComponent(id)}&exportFormat=zip`, ext: 'zip' };
}

/** JD applyFilenameExtension: the title with the export's extension. */
export function exportName(title: string, ext: string): string {
  return title.toLowerCase().endsWith(`.${ext}`) ? title : `${title}.${ext}`;
}

/** A Google document: its details from the web API (JD crawlAdditionalFileInformationFromWebsite), then the export. */
async function resolveDocument(ctx: Ctx, t: { id: string; resourceKey?: string }, fallbackTitle: string | undefined, headers: Record<string, string>) {
  const page = await ctx.http.get(`${fileUrl(t.id, t.resourceKey)}/view`, { headers });
  pageErrors(ctx, page);
  const key = fileApiKey(page.body) ?? webApiInfo(page.body).key;
  if (!key) {
    throw new TemporaryError({ de: 'Google Drive: Schlüssel für die Dokument-Details nicht gefunden', en: 'Google Drive: key for the document details not found' });
  }
  const query = [`fields=${encodeURIComponent(FIELDS)}`, 'supportsTeamDrives=true', 'enforceSingleParent=true', `key=${encodeURIComponent(key)}`];
  // JD: logged in `clients6.google.com/drive/v2internal`, else `content.googleapis.com/drive/v2beta`.
  const api = ctx.account.get() ? 'https://clients6.google.com/drive/v2internal' : 'https://content.googleapis.com/drive/v2beta';
  const res = await ctx.http.get(`${api}/files/${encodeURIComponent(t.id)}?${query.join('&')}`, {
    headers: {
      ...headers,
      ...authHeaders(ctx),
      Accept: '*/*',
      Origin: DRIVE,
      Referer: `${DRIVE}/`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Javascript-User-Agent': 'google-api-javascript-client/1.1.0',
      ...(t.resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${t.id}/${t.resourceKey}` } : {}),
    },
  });
  if (res.status === 404) throw new OfflineError({ de: 'Google Drive: Dokument nicht gefunden', en: 'Google Drive: document not found' });
  if (res.status === 403) throw privateError(ctx, 'file');
  if (res.status === 429) throw new TemporaryError({ de: 'Google Drive: Rate-Limit', en: 'Google Drive: rate limited' }, RATE_WAIT);
  let info: DriveItem & { exportLinks?: Record<string, string> } = { id: t.id };
  try {
    info = res.json();
  } catch {
    throw new TemporaryError({ de: `Google Drive: Dokument-Details nicht lesbar (HTTP ${res.status})`, en: `Google Drive: document details not readable (HTTP ${res.status})` });
  }
  const title = info.title || fallbackTitle || t.id;
  const chosen = chooseExport(t.id, title, info.mimeType, info.exportLinks);
  const file = await ctx.http.get(chosen.url, { headers });
  if (!file.file) {
    pageErrors(ctx, file);
    throw new TemporaryError({ de: 'Google Drive: Export des Dokuments nicht bekommen', en: 'Google Drive: could not get the document export' });
  }
  // An export has no size in advance and is made on the fly: one connection.
  return { url: file.url, name: exportName(title, chosen.ext), headers, maxConnections: 1 };
}

/** JD findConfirmDownloadurlForm: the confirm link or the download form on the warning page. */
export function confirmUrl(html: string, pageUrl: string): string | undefined {
  const link = /"([^"]*?\/uc[^"]+export=download[^<>"]*?confirm=[^<>"]+)"/i.exec(html)?.[1];
  // No URL class in QuickJS: resolveUrl from the SDK, query built by hand.
  if (link) return resolveUrl(pageUrl, decodeHtml(link));
  for (const m of html.matchAll(/href="([^"]+)"/gi)) {
    const href = decodeHtml(m[1]);
    if (/[?&]export=/.test(href) && /[?&]confirm=/.test(href)) return resolveUrl(pageUrl, href);
  }
  const form = parseForms(html).find((f) => /id=["'](?:download-form|downloadForm)["']/i.test(f.html));
  if (!form) return undefined;
  const action = resolveUrl(pageUrl, form.action || pageUrl).split('?')[0];
  const query = Object.entries(form.fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return query ? `${action}?${query}` : action;
}

export default definePlugin({
  id: 'gdrive',
  name: 'Google Drive',
  version: 6,
  matches: [LINK, FOLDER],
  accountRequired: false,
  // JD GoogleDriveCrawler logs in too: private folders of the account.
  crawlWithAccount: true,
  account: {
    userLabel: { de: 'Name (optional)', en: 'Name (optional)' },
    secretLabel: { de: 'Cookies aus dem Browser', en: 'Cookies from the browser' },
    secretMultiline: true,
    help: {
      de:
        'Google erlaubt Programmen kein Login mit Passwort; wie bei JDownloader meldet sich Haul mit den Cookies deines Browsers an. ' +
        'Im Browser bei drive.google.com anmelden, mit einer Cookie-Erweiterung (z. B. Cookie-Editor) die Cookies als JSON exportieren und hier einfügen ' +
        '(cookies.txt oder eine Zeile „Cookie: …“ gehen auch). Am besten dazu eine Zeile „User-Agent: …“ mit dem User-Agent dieses Browsers.',
      en:
        'Google does not let programs log in with a password; like JDownloader, Haul logs in with your browser’s cookies. ' +
        'Log in at drive.google.com, export the cookies as JSON with a cookie extension (e.g. Cookie-Editor) and paste them here ' +
        '(cookies.txt or a “Cookie: …” line work too). Best add a line “User-Agent: …” with that browser’s User-Agent.',
    },
  },

  // Folder links become their files; file links stay as they are (checked later).
  async crawl(link, ctx) {
    const headers = login(ctx);
    const target = OPEN.test(link) ? await openTarget(ctx, link, headers) : link;
    const folder = folderOf(target);
    if (folder) return crawlFolder(ctx, folder, headers);
    return { files: [{ url: target }] };
  },

  async check(link, ctx) {
    const t = target(link);
    const q = await quickCheck(ctx, t.id, t.resourceKey, login(ctx));
    // sizeBytes 0: a Google document; its name has no extension (JD does not trust it).
    const size = q.sizeBytes && q.sizeBytes > 0 ? q.sizeBytes : undefined;
    return { online: true, name: size ? q.fileName : undefined, size };
  },

  async resolve(link, ctx) {
    const t = target(link);
    const headers = login(ctx);
    const q = await quickCheck(ctx, t.id, t.resourceKey, headers);
    if ((q.scanResult ?? '').toUpperCase() === 'ERROR') {
      const d = (q.disposition ?? '').toUpperCase();
      if (d === 'QUOTA_EXCEEDED') {
        throw new TemporaryError(
          { de: 'Google Drive: Download-Kontingent der Datei erschöpft, später erneut', en: 'Google Drive: download quota of the file exceeded, trying later' },
          QUOTA_WAIT,
        );
      }
      if (d === 'FILE_INFECTED_NOT_OWNER') {
        throw new PluginError('fatal', {
          de: 'Google Drive: Datei laut Google mit Virus infiziert, nur der Besitzer kann sie laden',
          en: 'Google Drive: file infected according to Google, only the owner can download it',
        });
      }
      if (d === 'DOWNLOAD_RESTRICTED') {
        throw new PluginError('fatal', { de: 'Google Drive: Download vom Besitzer deaktiviert', en: 'Google Drive: download disabled by the owner' });
      }
      throw new PluginError('fatal', `Google Drive: ${q.disposition ?? 'ERROR'}`);
    }
    // JD: "Filesize field will be 0 for Google Documents and given downloadUrl will be broken".
    if (q.sizeBytes === 0) return resolveDocument(ctx, t, q.fileName, headers);
    const name = q.fileName;
    const size = q.sizeBytes && q.sizeBytes > 0 ? q.sizeBytes : undefined;
    const done = (url: string) => ({ url, name, size, headers, maxConnections: CONNECTIONS });
    // JD constructFileDirectDownloadUrl: `/u/0/uc` when logged in, "mimic browser behavior".
    const uc = ctx.account.get() ? `${DRIVE}/u/0/uc` : `${DRIVE}/uc`;
    let url = q.downloadUrl || `${uc}?id=${encodeURIComponent(t.id)}&export=download${t.resourceKey ? `&resourcekey=${encodeURIComponent(t.resourceKey)}` : ''}`;
    // Big files: a warning page ("too big for Google to virus-scan") links to the confirmed download.
    for (let step = 0; step < 2; step++) {
      const res = await ctx.http.get(url, { headers });
      if (res.file) return done(res.url);
      pageErrors(ctx, res);
      const next = confirmUrl(res.body, res.url);
      if (!next) break;
      url = next;
    }
    throw new TemporaryError({ de: 'Google Drive: Download-Link nicht gefunden', en: 'Google Drive: download link not found' });
  },

  // JD fetchAccountInfo: login(forceLoginValidation), a free account without traffic limit.
  async checkAccount(ctx) {
    const headers = login(ctx);
    const res = await ctx.http.get(`${DRIVE}/drive/my-drive`, { headers });
    if (res.status === 429) {
      throw new TemporaryError({ de: 'Google Drive: Rate-Limit', en: 'Google Drive: rate limited' }, RATE_WAIT);
    }
    // JD validateCookiesGoogleDrive: "Some URLs will redirect to accounts.google.com when not
    // logged in or login cookies expired".
    if (/^https?:\/\/accounts\.google\.com\//i.test(res.url)) {
      throw new AccountError({
        de: 'Google Drive: Cookies abgelaufen oder ungültig, bitte neu aus dem Browser exportieren',
        en: 'Google Drive: cookies expired or invalid, please export them from the browser again',
      });
    }
    if (!sapisid(ctx)) {
      // JD errorIncompleteLogin.
      throw new AccountError({
        de: 'Google Drive: Login unvollständig, das Cookie „SAPISID“ fehlt. Im Browser einmal das Google-Konto öffnen (Kontomenü → „Google-Konto“), dann Drive neu laden und die Cookies erneut exportieren',
        en: 'Google Drive: login incomplete, the cookie “SAPISID” is missing. Open the Google account once in the browser (account menu → “Google Account”), reload Drive and export the cookies again',
      });
    }
    return { valid: true, premium: false, message: 'Google' };
  },
});
