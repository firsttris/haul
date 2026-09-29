/**
 * 1fichier.com and its alias domains: free downloads without an account.
 *
 * References: JD's OneFichierCom.java (mirror 2026-09-28) and OneFichierComFolder.java
 * (r52861), pyLoad's OneFichierCom.py (1.23).
 *
 * - Links are `https://<domain>/?<id>`; the domain stays as given (JD: uploaders can restrict a
 *   file to one domain). Old `https://<id>.1fichier.com/` links are rewritten (pyLoad).
 * - Link check: `POST /check_links.pl` with `links[]=…` answers `url;name;size` per link, or a
 *   status (`NOT FOUND`, `BAD LINK`, `PRIVATE`) — deprecated but still working (JD).
 * - Download (JD handleDownloadWebsite): the file page may be the file itself (hotlink); else its
 *   first form is posted with `did=1` (without `save`), and the answer carries the link
 *   "Click here to download" / "Start your download".
 * - Password-protected files: the form has a `pass` field; after a wrong password the page shows
 *   that form again (JD isPasswordProtectedFileWebsite / errorWrongPassword). Protected folders:
 *   no JSON list, the password is posted to the folder page, whose HTML then lists the files
 *   (JD OneFichierComFolder.handlePasswordWebsite); the files get the folder's password.
 * - Limits: one free download at a time; between downloads a wait ("You must wait N minutes"),
 *   no free slots ("temporarily limited due to high demand", JD waits 15 min), daily limit
 *   ("The free offer is intended to …", 1 h). pyLoad also waits out "Free download in ⏳ N".
 * - Requests at least 2.5 s apart (JD default, "1 request per second is also fine" says the admin).
 */
import {
  decodeHtml,
  definePlugin,
  HosterLimitError,
  OfflineError,
  parseForms,
  parseSize,
  PluginError,
  resolveUrl,
  spaceRequests,
  TemporaryError,
  withPassword,
  WRONG_PASSWORD,
} from '@haul/plugin-sdk';
import type { Ctx, CrawledFile, HttpOptions, HttpResponse } from '@haul/plugin-sdk';

/** JD: getPluginDomains. */
const DOMAINS = [
  '1fichier.com', 'alterupload.com', 'cjoint.net', 'desfichiers.net', 'desfichiers.com', 'dfichiers.com',
  'megadl.fr', 'mesfichiers.org', 'piecejointe.net', 'pjointe.com', 'tenvoi.com', 'dl4free.com',
];
const HOSTS = DOMAINS.map((d) => d.replace(/\./g, '\\.')).join('|');
const FILE = new RegExp(`^https?://(?:www\\.)?(${HOSTS})/\\?([a-z0-9]{5,20})`, 'i');
/** pyLoad: `https://<id>.1fichier.com/`. */
const OLD_FILE = new RegExp(`^https?://([a-z0-9]{5,20})\\.(${HOSTS})/?(?:[?#].*)?$`, 'i');
const FOLDER = new RegExp(`^https?://(?:www\\.)?(${HOSTS})/(?:[a-z]{2}/)?dir/([A-Za-z0-9]+)`, 'i');
/** JD prepareBrowserWebsite. */
const UA = 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/48.0.2564.103 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-us,en;q=0.5',
};

/** `https://<domain>/?<id>`, the domain kept; null for other links. */
export function fileUrl(link: string): string | null {
  const m = FILE.exec(link);
  if (m) return `https://${m[1].toLowerCase()}/?${m[2].toLowerCase()}`;
  const old = OLD_FILE.exec(link);
  if (old && old[1].toLowerCase() !== 'www') return `https://${old[2].toLowerCase()}/?${old[1].toLowerCase()}`;
  return null;
}

function mustFileUrl(link: string): string {
  const url = fileUrl(link);
  if (!url) throw new PluginError('fatal', { de: `kein 1fichier-Datei-Link: ${link}`, en: `not a 1fichier file link: ${link}` });
  return url;
}

async function request(ctx: Ctx, method: 'GET' | 'POST', url: string, opts: HttpOptions & { form?: Record<string, string> } = {}) {
  await spaceRequests(ctx, 'https://1fichier.com', 2500);
  // JD sets the cookie LG=en and adds &lg=en: "only setting the cookie may not be enough".
  ctx.cookies.set(url, `LG=en; Path=/`);
  return ctx.http.request({ ...opts, method, url, headers: { ...HEADERS, ...(opts.headers ?? {}) } });
}

interface LinkInfo {
  online: boolean;
  name?: string;
  size?: number;
  /** PRIVATE: online, but access control (password, premium, country, owner). */
  restricted?: boolean;
}

/** JD checkLinks: `check_links.pl`, up to 100 links per request. */
async function checkLinks(ctx: Ctx, urls: string[]): Promise<Map<string, LinkInfo>> {
  const out = new Map<string, LinkInfo>();
  for (let i = 0; i < urls.length; i += 100) {
    const batch = urls.slice(i, i + 100);
    const res = await request(ctx, 'POST', 'https://1fichier.com/check_links.pl', {
      body: batch.map((u) => `links[]=${encodeURIComponent(u)}`).join('&'),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (res.status >= 500 || res.status === 403) {
      throw new TemporaryError({ de: `1fichier: Link-Check HTTP ${res.status}`, en: `1fichier: link check HTTP ${res.status}` });
    }
    for (const url of batch) {
      const id = url.split('?')[1];
      const line = res.body.split(/\r?\n/).find((l) => l.toLowerCase().includes(id));
      // JD: "This should not happen but let's treat such links as offline".
      if (!line) {
        out.set(url, { online: false });
        continue;
      }
      const parts = line.split(';');
      if (parts.length === 3) {
        out.set(url, { online: true, name: decodeHtml(parts[1]), size: Number(parts[2]) || undefined });
      } else if (parts.length >= 4) {
        const status = parts[3].trim().toUpperCase();
        out.set(url, status === 'PRIVATE' ? { online: true, restricted: true } : { online: false });
      } else {
        out.set(url, { online: false });
      }
    }
  }
  return out;
}

/** JD errorHandlingWebsite, the parts for downloads without an account, plus pyLoad's countdown. */
export function checkErrors(res: HttpResponse): void {
  const html = res.body;
  if (/>\s*File not found/i.test(html)) throw new OfflineError();
  if (/>\s*Software error:?\s*</i.test(html)) {
    throw new TemporaryError({ de: '1fichier: Serverfehler „Software error“', en: '1fichier: server error “Software error”' }, 10 * 60);
  }
  if (/>\s*Connexion à la base de données impossible<|>Can't connect DB/i.test(html) || /\/\?c=DB/.test(res.url)) {
    throw new TemporaryError({ de: '1fichier: interner Datenbankfehler', en: '1fichier: internal database error' }, 5 * 60);
  }
  if (/not possible to free unregistered users|is not possible to unregistered users|need a subscription/i.test(html)) {
    throw new PluginError('fatal', { de: '1fichier: nur mit Account ladbar', en: '1fichier: downloadable with an account only' });
  }
  if (/Your account will be unlock/i.test(html)) {
    throw new HosterLimitError({ de: '1fichier: IP aus Sicherheitsgründen gesperrt', en: '1fichier: IP blocked for security reasons' }, 60 * 60);
  }
  if (/>\s*(?:Access to this file is protected|This file is protected)/i.test(html)) {
    // JD: access control by the owner (IP, registered or premium users only, owner only).
    if (/>\s*The owner of this file has reserved access to the subscribers of our services/i.test(html)) {
      throw new PluginError('fatal', {
        de: '1fichier: der Besitzer erlaubt den Download nur Abonnenten',
        en: '1fichier: the owner reserved access to subscribers',
      });
    }
    throw new PluginError('fatal', {
      de: '1fichier: Zugriff vom Besitzer beschränkt (IP, Registrierte, Premium oder nur Besitzer)',
      en: '1fichier: access restricted by the owner (IP, registered, premium or owner only)',
    });
  }
  if (/>\s*Your requests are too fast/i.test(html)) {
    throw new HosterLimitError({ de: '1fichier: zu viele Anfragen', en: '1fichier: requests too fast' }, 30);
  }
  if (res.status === 403) throw new TemporaryError({ de: '1fichier: Serverfehler 403', en: '1fichier: server error 403' }, 15 * 60);
  if (res.status === 503 && />\s*Our services are in maintenance/i.test(html)) {
    throw new HosterLimitError({ de: '1fichier: Wartung', en: '1fichier: maintenance' }, 20 * 60);
  }
  if (
    /professional infrastructure detected|identified as belonging to a server, proxy, VPN|Usage of professional services is restricted/i.test(html)
  ) {
    throw new PluginError('fatal', {
      de: '1fichier: Server-, VPN- oder Proxy-IP erkannt; Downloads nur über private Anschlüsse',
      en: '1fichier: server, VPN or proxy IP detected; downloads only from private connections',
    });
  }
  if (/The free offer is intended to/i.test(html) && /You already downloaded for free more than|It is not designed for intensive|These limitations are necessary to/i.test(html)) {
    throw new HosterLimitError({ de: '1fichier: tägliches Free-Limit erreicht', en: '1fichier: daily free limit reached' }, 60 * 60);
  }
  if (/>\s*Free download is temporarily limited due to high demand|>\s*all free guest slots are currently in use/i.test(html)) {
    // JD: getNoFreeSlotsWaitMinutes() default 15.
    throw new HosterLimitError({ de: '1fichier: keine freien Slots, später erneut', en: '1fichier: no free slots, trying later' }, 15 * 60);
  }
  const internal = />\s*Internal error\s*(.*?)\s*<br\/>\s*Please try again later/i.exec(html)?.[1];
  if (internal !== undefined) throw new HosterLimitError(`1fichier: Internal error ${internal}`, 5 * 60);
  let minutes =
    /you must wait (?:at least|up to)\s*(\d+)\s*minutes between each downloads/i.exec(html)?.[1] ??
    />\s*You must wait\s*(\d+)\s*minutes/i.exec(html)?.[1] ??
    />\s*Vous devez attendre encore\s*(\d+)\s*minutes/i.exec(html)?.[1];
  if (/>\s*IP Locked|>\s*Will be unlocked within 1h\./i.test(html)) minutes = '60';
  const between = [
    /\/>\s*Téléchargements en cours/i,
    /En téléchargement standard, vous ne pouvez télécharger qu'un seul fichier/i,
    />\s*veuillez patienter avant de télécharger un autre fichier/i,
    />\s*You already downloading (?:some|a) file/i,
    />\s*You can download only one file at a time/i,
    />\s*Please wait a few seconds before downloading new ones/i,
    />\s*You must wait for another download/i,
    /Without premium status, you can download only one file at a time/i,
    /Without Premium, you can only download one file at a time/i,
    /Without Premium, you must wait between downloads/i,
    /Without subscription, you can only download one file at/i,
    />\s*Votre adresse IP ouvre trop de connexions vers le serveur/i,
  ].some((p) => p.test(html));
  if (minutes !== undefined || between) {
    // JD: 5 minutes when the page names no time.
    const wait = minutes !== undefined ? Number(minutes) * 60 : 5 * 60;
    throw new HosterLimitError(
      { de: `1fichier: Wartezeit zwischen Downloads (${Math.round(wait / 60)} min)`, en: `1fichier: wait between downloads (${Math.round(wait / 60)} min)` },
      wait,
    );
  }
}

/** pyLoad DL_LIMIT_PATTERN: "Free download in ⏳ 60". */
const freeCountdown = (html: string) => Number(/Free download in\s*⏳\s*(\d+)/i.exec(html)?.[1] ?? 0);

/** JD isPasswordProtectedFileWebsite: a form with a `pass` field that posts to 1fichier. */
function passwordForm(html: string, base: string) {
  return parseForms(html).find((f) => 'pass' in f.fields && (!f.action || !!fileUrl(resolveUrl(base, f.action)) || FOLDER.test(resolveUrl(base, f.action))));
}

/** JD OneFichierComFolder: the file rows of a folder page. */
export function folderRows(html: string): CrawledFile[] {
  const re = new RegExp(
    `<a href=("|')(https?://(?:www\\.)?(?:${HOSTS})/\\?[a-z0-9]{5,20}[^"']*)\\1[^>]*>([^\\r\\n\\t]+)</a>\\s*</td>\\s*<td[^>]*>([^\\r\\n\\t]+)</td>`,
    'gi',
  );
  const out: CrawledFile[] = [];
  for (const m of html.matchAll(re)) out.push({ url: decodeHtml(m[2]), name: decodeHtml(m[3]).trim(), size: parseSize(m[4]) });
  return out;
}

/** JD: the link on the page after the form. */
export function downloadLink(html: string): string | undefined {
  const a = /<a href="([^"]+)"[^>]*>\s*(?:Click here to|Start your) download/i.exec(html)?.[1];
  if (a) return decodeHtml(a);
  const b = /align:middle">\s+<a href=("|')(https?:\/\/[a-zA-Z0-9_-]+\.(?:1fichier|desfichiers)\.com\/[a-zA-Z0-9]+.*?)\1/i.exec(html)?.[2];
  return b ? decodeHtml(b) : undefined;
}

export default definePlugin({
  id: '1fichier',
  name: '1fichier',
  version: 2,
  matches: [FILE, OLD_FILE, FOLDER],
  accountRequired: false,
  // Free: one download at a time and requests spaced (JD); calls run one after another.
  serial: true,

  async crawl(link, ctx) {
    const folder = FOLDER.exec(link);
    if (folder) {
      const base = `https://${folder[1].toLowerCase()}/dir/${folder[2]}`;
      const json = await request(ctx, 'GET', `${base}?json=1`);
      if (json.status === 404) throw new OfflineError({ de: '1fichier: Ordner nicht gefunden', en: '1fichier: folder not found' });
      checkErrors(json);
      let list: Array<{ filename: string; size: number; link: string; password?: number; acl?: number }>;
      try {
        list = json.json();
      } catch {
        list = [];
      }
      const page = await request(ctx, 'GET', `${base}?lg=en`);
      const title = />(?:Shared folder|Dossier partagé)\s*(.*?)</i.exec(page.body)?.[1];
      const packageName = title ? decodeHtml(title).trim() : undefined;
      if (Array.isArray(list) && json.body.trim().startsWith('[')) {
        return { packageName, files: list.map((f) => ({ url: f.link, name: f.filename, size: f.size })) };
      }
      // JD: no JSON list → password-protected folder. JD posts to `<folder>?lg=en?json=1`
      // (sic) and reads the file rows from the HTML answer.
      if (!passwordForm(page.body, base)) {
        checkErrors(page);
        throw new TemporaryError({ de: '1fichier: Ordnerinhalt nicht lesbar', en: '1fichier: folder content not readable' });
      }
      const files = await withPassword(ctx, '1fichier', async (password) => {
        const res = await request(ctx, 'POST', `${base}?lg=en?json=1`, { form: { pass: password }, headers: { Referer: `${base}?lg=en` } });
        if (passwordForm(res.body, base)) return WRONG_PASSWORD;
        checkErrors(res);
        return folderRows(res.body);
      });
      if (!files.length) throw new TemporaryError({ de: '1fichier: keine Dateien im Ordner gefunden', en: '1fichier: no files found in the folder' });
      return { packageName, files };
    }
    const url = mustFileUrl(link);
    const info = (await checkLinks(ctx, [url])).get(url)!;
    if (!info.online) throw new OfflineError();
    return { files: [{ url, name: info.name, size: info.size }] };
  },

  async check(link, ctx) {
    const url = mustFileUrl(link);
    const info = (await checkLinks(ctx, [url])).get(url)!;
    return { online: info.online, name: info.name, size: info.size };
  },

  async resolve(link, ctx) {
    const url = mustFileUrl(link);
    const page = `${url}&lg=en`;
    let res = await request(ctx, 'GET', page);
    for (let round = 0; ; round++) {
      // Hotlink: the uploader pays the traffic, several connections are fine (JD: -3).
      if (res.file) return { url: res.url, headers: { 'User-Agent': UA, Referer: url }, maxConnections: 3 };
      if (res.status === 404) throw new OfflineError();
      checkErrors(res);
      const wait = freeCountdown(res.body);
      if (!wait || round >= 2) break;
      // pyLoad: wait out the countdown, then load the page again; long waits go back to the queue.
      if (wait > 180) {
        throw new HosterLimitError({ de: `1fichier: Free-Download in ${wait} s`, en: `1fichier: free download in ${wait} s` }, wait);
      }
      await ctx.wait(wait + 1);
      res = await request(ctx, 'GET', page);
    }
    const form = parseForms(res.body)[0];
    if (!form) {
      throw new TemporaryError({ de: '1fichier: kein Download-Formular auf der Seite', en: '1fichier: no download form on the page' });
    }
    // JD: the form without `save`, with `did=1`, and the password if the file has one.
    const submit = (f: typeof form, password?: string) => {
      const fields: Record<string, string> = { ...f.fields, did: '1' };
      delete fields.save;
      if (password !== undefined) fields.pass = password;
      return request(ctx, 'POST', f.action ? resolveUrl(page, f.action) : page, { form: fields, headers: { Referer: page } });
    };
    const action = form.action ? resolveUrl(page, form.action) : page;
    if (passwordForm(res.body, page)) {
      let current = form;
      res = await withPassword(ctx, '1fichier', async (password) => {
        const answer = await submit(current, password);
        // Wrong: the page asks again; its first form is the next one to send (JD: getForm(0)).
        if (answer.file || !passwordForm(answer.body, page)) return answer;
        current = parseForms(answer.body)[0] ?? current;
        return WRONG_PASSWORD;
      });
    } else {
      res = await submit(form);
    }
    if (res.file && res.url !== action) return { url: res.url, headers: { 'User-Agent': UA, Referer: url }, maxConnections: 1 };
    const dl = downloadLink(res.body);
    if (dl) return { url: dl, headers: { 'User-Agent': UA, Referer: url }, maxConnections: 1 };
    checkErrors(res);
    throw new TemporaryError({
      de: `1fichier: Download-Link nicht gefunden (HTTP ${res.status})`,
      en: `1fichier: download link not found (HTTP ${res.status})`,
    });
  },
});
