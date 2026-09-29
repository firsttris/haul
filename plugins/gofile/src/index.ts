/**
 * gofile.io: free downloads without captcha, folder links expand into their files.
 *
 * Reference: JD's GofileIo.java and GoFileIoCrawler.java (SVN r53159). Everything goes through
 * the website's API with a guest token:
 *
 * - `POST api.gofile.io/accounts` creates the token; JD reuses it for 30 minutes.
 * - `GET api.gofile.io/contents/<code>` lists a folder, with the token as Bearer and an
 *   `X-Website-Token` hashed from User-Agent, token and the current 4-hour block.
 * - The file's `link` downloads with the cookie `accountToken=<token>` and a gofile Referer;
 *   the link is bound to the token and expires, so `resolve` lists the folder again.
 */
import { definePlugin, OfflineError, PluginError, TemporaryError } from '@haul/plugin-sdk';
import type { Ctx, CrawledFile, HttpResponse } from '@haul/plugin-sdk';

const SITE = 'https://gofile.io';
const API = 'https://api.gofile.io';
/** Part of the website token; the site's own script uses the same constant (JD: 2026-06). */
const WT_SALT = '9844d94d963d30';
/** Sent with every API request, because the website token is hashed from it. */
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
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

function folderCode(link: string): string {
  const m = LINK.exec(link);
  if (!m) throw new PluginError('fatal', `kein Gofile-Link: ${link}`);
  return m[1];
}

function fileId(link: string): string | undefined {
  return /#file=([A-Za-z0-9-]+)/.exec(link)?.[1];
}

/** JD's getPage: gofile answers 429 when requests come too fast; wait 5 s, up to 5 times. */
async function api(ctx: Ctx, send: () => Promise<HttpResponse>): Promise<ApiResponse> {
  for (let i = 0; i <= 5; i++) {
    const res = await send();
    if (res.status === 429) {
      await ctx.wait(5);
      continue;
    }
    if (res.status !== 200) throw new TemporaryError(`Gofile-API: HTTP ${res.status}`);
    return res.json<ApiResponse>();
  }
  throw new TemporaryError('Gofile: zu viele Anfragen, später erneut');
}

function headers(token?: string): Record<string, string> {
  return {
    'User-Agent': UA,
    Origin: SITE,
    Referer: SITE + '/',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** The guest token, kept as the site's own cookie so it also goes along with downloads. */
async function guestToken(ctx: Ctx): Promise<string> {
  const saved = /(?:^|;\s*)accountToken=([^;]+)/.exec(ctx.cookies.get(SITE + '/'))?.[1];
  if (saved) return saved;
  const r = await api(ctx, () => ctx.http.post(`${API}/accounts`, null, { json: {}, headers: headers() }));
  const token = r.data?.token;
  if (r.status !== 'ok' || !token) throw new TemporaryError(`Gofile: kein Gast-Token (${r.status})`);
  ctx.cookies.set(SITE + '/', `${TOKEN_COOKIE}=${token}; Domain=gofile.io; Path=/; Max-Age=1800`);
  return token;
}

/** `X-Website-Token` like JD's generateWT: `UA::lang::token::4h-block::salt`, lang empty. */
function websiteToken(ctx: Ctx, token: string): string {
  const block = Math.floor(Date.now() / 1000 / 14400);
  return ctx.hash.sha256(`${UA}::::${token}::${block}::${WT_SALT}`);
}

async function contents(ctx: Ctx, code: string): Promise<Item> {
  const token = await guestToken(ctx);
  const url = `${API}/contents/${encodeURIComponent(code)}?contentId=${encodeURIComponent(code)}`;
  const r = await api(ctx, () =>
    ctx.http.get(url, { headers: { ...headers(token), 'X-Website-Token': websiteToken(ctx, token) } }),
  );
  if (r.status === 'error-notFound') throw new OfflineError('Gofile: Ordner oder Datei gelöscht');
  if (r.status === 'error-notPremium') throw new PluginError('fatal', 'Gofile: nur mit Premium-Account');
  if (r.status !== 'ok') throw new TemporaryError(`Gofile: ${r.status}`);
  const data = r.data;
  if (data.passwordStatus === 'passwordRequired' || data.passwordStatus === 'passwordWrong') {
    throw new PluginError('fatal', 'Gofile: Ordner ist passwortgeschützt (noch nicht unterstützt)');
  }
  if (data.canAccess === false) throw new PluginError('fatal', 'Gofile: privater Ordner');
  return data;
}

/** Files of a folder listing; a listing of a single file is that file. */
function filesOf(data: Item): Item[] {
  if (data.type === 'file') return [data];
  return Object.entries(data.children ?? {}).map(([id, item]) => ({ ...item, id: item.id ?? id }));
}

export default definePlugin({
  id: 'gofile',
  name: 'Gofile',
  version: 1,
  matches: [LINK],
  accountRequired: false,

  async crawl(link, ctx) {
    const code = folderCode(link);
    const files: CrawledFile[] = [];
    const seen = new Set<string>();
    let packageName: string | undefined;
    const walk = async (code: string, depth: number) => {
      if (seen.has(code) || depth > MAX_DEPTH) return;
      seen.add(code);
      const data = await contents(ctx, code);
      if (depth === 0 && data.type === 'folder') packageName = data.name;
      for (const item of filesOf(data)) {
        if (item.type === 'folder') {
          if (item.code) await walk(item.code, depth + 1);
        } else if (item.type === 'file') {
          // The folder's short code, so `resolve` can list it again for a fresh link.
          const parent = data.type === 'folder' ? (data.code ?? code) : code;
          files.push({ url: `${SITE}/d/${parent}#file=${item.id}`, name: item.name, size: item.size });
        }
      }
    };
    await walk(code, 0);
    // A link to one file inside a folder (`#file=`) stays that one file.
    const only = fileId(link);
    return { packageName, files: only ? files.filter((f) => fileId(f.url) === only) : files };
  },

  async check(link, ctx) {
    const id = fileId(link);
    const data = await contents(ctx, folderCode(link));
    const files = filesOf(data);
    const file = id ? files.find((f) => f.id === id) : files.length === 1 ? files[0] : undefined;
    if (!file) return { online: !id };
    return { online: true, name: file.name, size: file.size };
  },

  async resolve(link, ctx) {
    const id = fileId(link);
    const data = await contents(ctx, folderCode(link));
    const files = filesOf(data).filter((f) => f.type === 'file');
    const file = id ? files.find((f) => f.id === id) : files.length === 1 ? files[0] : undefined;
    if (!file) {
      if (id) throw new OfflineError('Gofile: Datei nicht mehr im Ordner');
      throw new PluginError('fatal', 'Gofile: Ordner-Link, bitte neu hinzufügen');
    }
    // JD refuses these too: the website offers no download for them.
    if (file.viruses && file.viruses.length) {
      throw new PluginError('fatal', 'Gofile: Datei als Schadsoftware markiert');
    }
    const url = file.link || file.directLink;
    if (!url) throw new TemporaryError('Gofile: kein Download-Link');
    const token = await guestToken(ctx);
    return {
      url,
      name: file.name,
      size: file.size,
      headers: { 'User-Agent': UA, Referer: SITE + '/' },
      cookies: { [TOKEN_COOKIE]: token },
      // JD: getMaxChunks() = -3, for free and premium.
      maxConnections: 3,
    };
  },
});
