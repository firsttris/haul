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
 */
import {
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
} from '@haul/plugin-sdk';
import type { Bilingual, Ctx, CrawledFile, HttpResponse } from '@haul/plugin-sdk';

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
        files.push({ url: fileUrl(f), name: f.filename, size: sizeOf(f) });
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
  version: 1,
  matches: [new RegExp(`^https?://${HOSTS}/.+`, 'i'), /^https?:\/\/download\d+\.mediafire(?:cdn)?\.com\//i],
  accountRequired: false,

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
      return { files: [{ url: t.direct ?? link, name: f.filename, size: sizeOf(f) }] };
    }
    for (const f of infos.values()) if (!deleted(f)) files.push({ url: fileUrl(f), name: f.filename, size: sizeOf(f) });
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
    return { online: true, name: f.filename, size: sizeOf(f) };
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
    if (res.file) return { ...download(res.url, ua, pageUrl), name: info.filename, size: sizeOf(info) };
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
      if (res.file) return { ...download(res.url, ua, pageUrl), name: info.filename, size: sizeOf(info) };
    }
    if (/aria-labelledby\s*=\s*"passwordmsg"|class\s*=\s*"passwordPrompt"/i.test(res.body)) {
      throw new PluginError('fatal', {
        de: 'Mediafire: passwortgeschützte Datei (noch nicht unterstützt)',
        en: 'Mediafire: password-protected file (not supported yet)',
      });
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
    return { ...download(url, ua, res.url), name: info.filename, size: sizeOf(info) };
  },
});
