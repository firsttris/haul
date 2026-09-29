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
 * - Not yet: folders, Google Docs exports, video streams, Google accounts.
 */
import { decodeHtml, definePlugin, OfflineError, parseForms, PluginError, resolveUrl, TemporaryError } from '@haul/plugin-sdk';
import type { Ctx, HttpResponse } from '@haul/plugin-sdk';

const HOSTS = '(?:drive|docs|drive\\.usercontent)\\.google\\.com';
/** JD getAnnotationUrls, without Google Docs documents (they need an export). */
const LINK = new RegExp(
  `^https?://${HOSTS}/(?:(?:leaf|open)\\?(?:[^"<>/]*?&)?id=[A-Za-z0-9_-]+|(?:u/\\d+/)?uc\\?(?:[^"<>]*?&)?id=[A-Za-z0-9_-]+|download\\?(?:[^"<>]*?&)?id=[A-Za-z0-9_-]+|(?:a/[a-zA-Z0-9.]+/)?file/d/[A-Za-z0-9_-]+)`,
  'i',
);
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
    throw new TemporaryError({ de: 'Google Drive: von Google blockiert (automatische Anfragen)', en: 'Google Drive: blocked by Google (automated queries)' }, RATE_WAIT);
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
  version: 1,
  matches: [LINK],
  accountRequired: false,

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
