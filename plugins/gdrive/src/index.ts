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
 * - Not yet: Google Docs exports, video streams, Google accounts.
 */
import { decodeHtml, definePlugin, HosterLimitError, OfflineError, parseForms, PluginError, resolveUrl, TemporaryError } from '@haul/plugin-sdk';
import type { CrawledFile, Ctx, FileHash, HttpResponse } from '@haul/plugin-sdk';

const HOSTS = '(?:drive|docs|drive\\.usercontent)\\.google\\.com';
/** JD getAnnotationUrls, without Google Docs documents (they need an export). */
const LINK = new RegExp(
  `^https?://${HOSTS}/(?:(?:leaf|open)\\?(?:[^"<>/]*?&)?id=[A-Za-z0-9_-]+|(?:u/\\d+/)?uc\\?(?:[^"<>]*?&)?id=[A-Za-z0-9_-]+|download\\?(?:[^"<>]*?&)?id=[A-Za-z0-9_-]+|(?:a/[a-zA-Z0-9.]+/)?file/d/[A-Za-z0-9_-]+)`,
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

/** File id and resource key (JD getFID / getFileResourceKey). */
export function parseLink(link: string): { id: string; resourceKey?: string } | undefined {
  const id =
    /\/file\/d\/([A-Za-z0-9_-]+)/i.exec(link)?.[1] ??
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
export function pageErrors(res: HttpResponse): void {
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
    throw new PluginError('fatal', {
      de: 'Google Drive: private Datei, nur mit Google-Account mit Berechtigung',
      en: 'Google Drive: private file, only with a Google account that has access',
    });
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
async function crawlFolder(ctx: Ctx, start: { id: string; resourceKey?: string }) {
  const page = await ctx.http.get(folderUrl(start.id, start.resourceKey), { headers: HEADERS });
  if (page.status === 404) throw new OfflineError({ de: 'Google Drive: Ordner nicht gefunden', en: 'Google Drive: folder not found' });
  if (/^https?:\/\/accounts\.google\.com\//i.test(page.url) || page.status === 403) {
    throw new PluginError('fatal', {
      de: 'Google Drive: privater Ordner, nur mit Google-Account mit Berechtigung',
      en: 'Google Drive: private folder, only with a Google account that has access',
    });
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
      ...HEADERS,
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
async function openTarget(ctx: Ctx, link: string): Promise<string> {
  let url = link.replace(/^http:/i, 'https:');
  for (let i = 0; i <= 3; i++) {
    const res = await ctx.http.get(url, { headers: HEADERS, followRedirects: false });
    const location = res.status >= 300 && res.status < 400 ? res.header('location') : null;
    // JD: no redirect on the first request → offline.
    if (!location) throw new OfflineError({ de: 'Google Drive: Link nicht gefunden', en: 'Google Drive: link not found' });
    url = resolveUrl(url, location);
    if (!OPEN.test(url) && (FOLDER.test(url) || LINK.test(url))) return url;
  }
  throw new TemporaryError({ de: 'Google Drive: zu viele Weiterleitungen', en: 'Google Drive: too many redirects' });
}

/** JD handleLinkcheckQuick. */
async function quickCheck(ctx: Ctx, id: string, resourceKey?: string): Promise<Quick> {
  const q = [`id=${encodeURIComponent(id)}`];
  if (resourceKey) q.push(`resourcekey=${encodeURIComponent(resourceKey)}`);
  q.push('authuser=0', 'export=download');
  const res = await ctx.http.post(`https://drive.google.com/uc?${q.join('&')}`, '', {
    headers: { ...HEADERS, 'X-Drive-First-Party': 'DriveViewer' },
  });
  if (res.status === 404) throw new OfflineError({ de: 'Google Drive: Datei nicht gefunden', en: 'Google Drive: file not found' });
  if (res.status === 403) {
    throw new PluginError('fatal', {
      de: 'Google Drive: private Datei, nur mit Google-Account mit Berechtigung',
      en: 'Google Drive: private file, only with a Google account that has access',
    });
  }
  pageErrors(res);
  const json = /(\{[\s\S]+\})\s*$/.exec(res.body)?.[1];
  if (!json) throw new TemporaryError({ de: `Google Drive: unerwartete Antwort (HTTP ${res.status})`, en: `Google Drive: unexpected answer (HTTP ${res.status})` });
  return JSON.parse(json) as Quick;
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
  version: 4,
  matches: [LINK, FOLDER],
  accountRequired: false,

  // Folder links become their files; file links stay as they are (checked later).
  async crawl(link, ctx) {
    const target = OPEN.test(link) ? await openTarget(ctx, link) : link;
    const folder = folderOf(target);
    if (folder) return crawlFolder(ctx, folder);
    return { files: [{ url: target }] };
  },

  async check(link, ctx) {
    const t = target(link);
    const q = await quickCheck(ctx, t.id, t.resourceKey);
    // sizeBytes 0: a Google document; its name has no extension (JD does not trust it).
    const size = q.sizeBytes && q.sizeBytes > 0 ? q.sizeBytes : undefined;
    return { online: true, name: size ? q.fileName : undefined, size };
  },

  async resolve(link, ctx) {
    const t = target(link);
    const q = await quickCheck(ctx, t.id, t.resourceKey);
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
    if (q.sizeBytes === 0) {
      throw new PluginError('fatal', {
        de: 'Google Drive: Google-Dokument (Export noch nicht unterstützt)',
        en: 'Google Drive: Google document (export not supported yet)',
      });
    }
    const name = q.fileName;
    const size = q.sizeBytes && q.sizeBytes > 0 ? q.sizeBytes : undefined;
    const done = (url: string) => ({ url, name, size, headers: HEADERS, maxConnections: CONNECTIONS });
    let url = q.downloadUrl || `https://drive.google.com/uc?id=${encodeURIComponent(t.id)}&export=download`;
    // Big files: a warning page ("too big for Google to virus-scan") links to the confirmed download.
    for (let step = 0; step < 2; step++) {
      const res = await ctx.http.get(url, { headers: HEADERS });
      if (res.file) return done(res.url);
      pageErrors(res);
      const next = confirmUrl(res.body, res.url);
      if (!next) break;
      url = next;
    }
    throw new TemporaryError({ de: 'Google Drive: Download-Link nicht gefunden', en: 'Google Drive: download link not found' });
  },
});
