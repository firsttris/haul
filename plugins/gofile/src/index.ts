/**
 * gofile.io: free downloads without captcha, folder links expand into their files.
 *
 * References: JD's GofileIo.java / GoFileIoCrawler.java, pyLoad's GofileIo plugins, and the
 * gofile-dl / gofile-downloader tools (which track the website's changes, salt 2026-08).
 *
 * - `POST api.gofile.io/accounts` creates a guest token. Account creation and folder listings
 *   are what gofile's guest rate limit (`error-rateLimit`) counts, so both are kept rare:
 *   the token is reused, and a folder is listed once, when the link is added.
 * - `GET api.gofile.io/contents/<code>` lists a folder, with the token as Bearer and an
 *   `X-Website-Token` = sha256(`UA::lang::token::4h-block::salt`). User-Agent and `X-BL`
 *   must match the hashed values. Two sources disagree on the current salt, so both variants
 *   are kept exactly as their source sends them, and the one that worked last goes first.
 * - Like pyLoad (and JD's stored direct URL), the crawled file link carries the direct URL and
 *   its token, so `resolve` normally needs no API call; JD's checkDirectLink tests it first and
 *   only an expired link lists the folder again.
 * - The download needs the cookie `accountToken=<token>` and a gofile Referer.
 */
import { definePlugin, memo, OfflineError, PluginError, spaceRequests, TemporaryError } from '@haul/plugin-sdk';
import type { Ctx, CrawledFile, HttpResponse } from '@haul/plugin-sdk';

const SITE = 'https://gofile.io';
const API = 'https://api.gofile.io';
/**
 * Salts from gofile's wt.obf.js, current first. gofile rotates it; a wrong one answers
 * `error-notPremium`, then the next is tried. (12af…: gofile-dl 2026-08; 9844…: JD r53159.)
 */
interface WtVariant {
  salt: string;
  /** Hashed into the token, and sent as `X-BL` unless empty. */
  lang: string;
  /** Query of `/contents/<code>`, as the source sends it. */
  query: (code: string) => string;
}
const WT_VARIANTS: WtVariant[] = [
  // gofile-dl (salt update 2026-08-15) and gofile-downloader: the web client's query and X-BL.
  {
    salt: '12af056dacea0b',
    lang: 'en-US',
    query: () => 'contentFilter=&page=1&pageSize=1000&sortField=createTime&sortDirection=-1',
  },
  // JD's GoFileIoCrawler (r53159, mirror 2026-09-28): no language, no X-BL, only contentId.
  { salt: '9844d94d963d30', lang: '', query: (code) => `contentId=${encodeURIComponent(code)}` },
];
/** Sent with every request to gofile, because the website token is hashed from it. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TOKEN_COOKIE = 'accountToken';
const LINK = /^https?:\/\/(?:www\.)?gofile\.io\/(?:d\/|\?c=|#download#)([A-Za-z0-9-]+)/i;
/** Subfolders are followed this deep. */
const MAX_DEPTH = 5;

interface Item {
  id: string;
  type: 'file' | 'folder';
  name?: string;
  code?: string;
  size?: number;
  link?: string;
  directLink?: string;
  viruses?: unknown[];
  canAccess?: boolean;
  passwordStatus?: string;
  children?: Record<string, Item>;
}

interface ApiResponse {
  status: string;
  data: Item & { token?: string };
}

/** What a crawled link carries after `#`: file id, and the direct URL with its token. */
interface Fragment {
  file?: string;
  dl?: string;
  t?: string;
}

function folderCode(link: string): string {
  const m = LINK.exec(link);
  if (!m) throw new PluginError('fatal', { de: `kein Gofile-Link: ${link}`, en: `not a Gofile link: ${link}` });
  return m[1];
}

function fragment(link: string): Fragment {
  const out: Record<string, string> = {};
  const hash = link.split('#').slice(1).join('#');
  for (const part of hash.split('&')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

function fileLink(code: string, item: Item, token: string): string {
  const url = item.link || item.directLink;
  let link = `${SITE}/d/${code}#file=${item.id}`;
  if (url && !item.viruses?.length) link += `&t=${token}&dl=${encodeURIComponent(url)}`;
  return link;
}

/** JD's 500 ms request interval for gofile (setRequestIntervalLimitGlobal). */
const pace = (ctx: Ctx) => spaceRequests(ctx, API, 500);

/**
 * One API request with gofile's two ways of saying "too fast": HTTP 429 (JD: wait 5 s, up to
 * 5 times) and `error-rateLimit` (gofile-dl: back off 3, 6, 9 s).
 */
async function api(ctx: Ctx, send: () => Promise<HttpResponse>): Promise<ApiResponse> {
  for (let i = 0; i < 4; i++) {
    await pace(ctx);
    const res = await send();
    if (res.status === 429) {
      await ctx.wait(5);
      continue;
    }
    if (res.status !== 200 && !(res.header('content-type') ?? '').includes('json')) {
      throw new TemporaryError(`Gofile-API: HTTP ${res.status}`);
    }
    const r = res.json<ApiResponse>();
    if (r.status === 'error-rateLimit') {
      await ctx.wait(3 * (i + 1));
      continue;
    }
    return r;
  }
  throw new TemporaryError({
    de: 'Gofile: Rate-Limit für Gäste erreicht, später erneut',
    en: 'Gofile: guest rate limit reached, trying later',
  });
}

function headers(token: string, lang = ''): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': UA,
    Accept: '*/*',
    ...(lang ? { 'X-BL': lang } : {}),
    Origin: SITE,
    Referer: SITE + '/',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** `X-Website-Token` as computed by the site's wt.obf.js. */
function websiteToken(ctx: Ctx, token: string, v: WtVariant): string {
  const block = Math.floor(Date.now() / 1000 / 14400);
  return ctx.hash.sha256(`${UA}::${v.lang}::${token}::${block}::${v.salt}`);
}

/** The variant that worked last (kept with `memo`, never sent to gofile). */
function variantOrder(ctx: Ctx): WtVariant[] {
  const last = Number(memo.get(ctx, SITE, 'wt') ?? 0);
  const first = WT_VARIANTS[last] ?? WT_VARIANTS[0];
  return [first, ...WT_VARIANTS.filter((v) => v !== first)];
}

/**
 * The guest token, kept as the site's own cookie so it also goes along with downloads. A
 * guest account does not expire quickly; creating new ones is what gets rate-limited.
 */
async function guestToken(ctx: Ctx): Promise<string> {
  const saved = /(?:^|;\s*)accountToken=([^;]+)/.exec(ctx.cookies.get(SITE + '/'))?.[1];
  if (saved) return saved;
  const r = await api(ctx, () => ctx.http.post(`${API}/accounts`, null, { json: {}, headers: headers('') }));
  const token = r.data?.token;
  if (r.status !== 'ok' || !token) {
    throw new TemporaryError({
      de: `Gofile: kein Gast-Token (${r.status})`,
      en: `Gofile: no guest token (${r.status})`,
    });
  }
  ctx.cookies.set(SITE + '/', `${TOKEN_COOKIE}=${token}; Domain=gofile.io; Path=/; Max-Age=86400`);
  return token;
}

async function contents(ctx: Ctx, code: string): Promise<{ data: Item; token: string }> {
  const token = await guestToken(ctx);
  let r: ApiResponse | undefined;
  for (const v of variantOrder(ctx)) {
    const url = `${API}/contents/${encodeURIComponent(code)}?${v.query(code)}`;
    r = await api(ctx, () =>
      ctx.http.get(url, { headers: { ...headers(token, v.lang), 'X-Website-Token': websiteToken(ctx, token, v) } }),
    );
    // A wrong token is answered with error-notPremium (gofile-dl); try the other variant.
    if (r.status !== 'error-notPremium') {
      memo.set(ctx, SITE, 'wt', String(WT_VARIANTS.indexOf(v)));
      break;
    }
  }
  if (!r) throw new TemporaryError({ de: 'Gofile: keine Antwort', en: 'Gofile: no answer' });
  if (r.status === 'error-notFound') {
    throw new OfflineError({
      de: 'Gofile: Ordner oder Datei gelöscht',
      en: 'Gofile: folder or file deleted',
    });
  }
  if (r.status === 'error-notPremium') {
    throw new PluginError('fatal', {
      de: 'Gofile: Website-Token abgelehnt (Salt geändert?) oder nur mit Premium',
      en: 'Gofile: website token rejected (salt changed?) or premium only',
    });
  }
  if (r.status !== 'ok') throw new TemporaryError(`Gofile: ${r.status}`);
  const data = r.data;
  if (data.passwordStatus === 'passwordRequired' || data.passwordStatus === 'passwordWrong') {
    throw new PluginError('fatal', {
      de: 'Gofile: Ordner ist passwortgeschützt (noch nicht unterstützt)',
      en: 'Gofile: the folder is password protected (not supported yet)',
    });
  }
  if (data.canAccess === false) {
    throw new PluginError('fatal', {
      de: 'Gofile: privater Ordner',
      en: 'Gofile: private folder',
    });
  }
  return { data, token };
}

/** Files of a folder listing; a listing of a single file is that file. */
function filesOf(data: Item): Item[] {
  if (data.type === 'file') return [data];
  return Object.entries(data.children ?? {})
    .map(([id, item]) => ({ ...item, id: item.id ?? id }))
    .filter((f) => f.type === 'file');
}

/** The file a link means: its `#file=`, or the only file of a folder. */
function pick(data: Item, link: string): Item | undefined {
  const id = fragment(link).file;
  const files = filesOf(data);
  return id ? files.find((f) => f.id === id) : files.length === 1 ? files[0] : undefined;
}

/** JD's checkDirectLink: a HEAD request; a valid link answers with the file itself. */
async function directLinkWorks(ctx: Ctx, url: string, token: string): Promise<boolean> {
  try {
    const res = await ctx.http.request({
      method: 'HEAD',
      url,
      headers: { 'User-Agent': UA, Referer: SITE + '/', Cookie: `${TOKEN_COOKIE}=${token}` },
      timeoutMs: 20000,
    });
    return res.ok() && res.file && !/gofile\.io\/d\//.test(res.url);
  } catch {
    return false;
  }
}

function download(url: string, token: string, item?: Item) {
  return {
    url,
    name: item?.name,
    size: item?.size,
    headers: { 'User-Agent': UA, Referer: SITE + '/' },
    cookies: { [TOKEN_COOKIE]: token },
    // JD: getMaxChunks() = -3, for free and premium.
    maxConnections: 3,
  };
}

export default definePlugin({
  id: 'gofile',
  name: 'Gofile',
  version: 2,
  matches: [LINK],
  accountRequired: false,
  // JD: getMaxConcurrentProcessingInstances() = 1 "to prevent running into rate-limit".
  serial: true,

  async crawl(link, ctx) {
    const files: CrawledFile[] = [];
    const seen = new Set<string>();
    let packageName: string | undefined;
    // A link to one file inside a folder (`#file=`) stays that one file; its folder is enough.
    const only = fragment(link).file;
    const walk = async (code: string, depth: number) => {
      if (seen.has(code) || depth > MAX_DEPTH) return;
      seen.add(code);
      const { data, token } = await contents(ctx, code);
      if (depth === 0 && data.type === 'folder') packageName = data.name;
      // The folder's short code, so an expired link can be listed again.
      const parent = data.type === 'folder' ? (data.code ?? code) : code;
      for (const item of filesOf(data)) {
        files.push({ url: fileLink(parent, item, token), name: item.name, size: item.size });
      }
      if (only) return;
      for (const [, sub] of Object.entries(data.children ?? {})) {
        if (sub.type === 'folder' && sub.code) await walk(sub.code, depth + 1);
      }
    };
    await walk(folderCode(link), 0);
    return { packageName, files: only ? files.filter((f) => fragment(f.url).file === only) : files };
  },

  async check(link, ctx) {
    const f = fragment(link);
    if (f.dl && f.t && (await directLinkWorks(ctx, f.dl, f.t))) return { online: true };
    const file = pick((await contents(ctx, folderCode(link))).data, link);
    if (!file) return { online: !f.file };
    return { online: true, name: file.name, size: file.size };
  },

  async resolve(link, ctx) {
    const f = fragment(link);
    // The link from the crawl, as long as it still works: no API request at all.
    if (f.dl && f.t && (await directLinkWorks(ctx, f.dl, f.t))) return download(f.dl, f.t);
    const { data, token } = await contents(ctx, folderCode(link));
    const file = pick(data, link);
    if (!file) {
      if (f.file) {
        throw new OfflineError({
          de: 'Gofile: Datei nicht mehr im Ordner',
          en: 'Gofile: the file is no longer in the folder',
        });
      }
      throw new PluginError('fatal', {
        de: 'Gofile: Ordner mit mehreren Dateien, bitte den Link neu hinzufügen',
        en: 'Gofile: folder with several files, please add the link again',
      });
    }
    // JD refuses these too: the website offers no download for them.
    if (file.viruses && file.viruses.length) {
      throw new PluginError('fatal', {
        de: 'Gofile: Datei als Schadsoftware markiert',
        en: 'Gofile: the file is flagged as malware',
      });
    }
    const url = file.link || file.directLink;
    if (!url) throw new TemporaryError({ de: 'Gofile: kein Download-Link', en: 'Gofile: no download link' });
    return download(url, token, file);
  },
});
