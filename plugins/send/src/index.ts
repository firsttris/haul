/**
 * send.now (formerly send.cm, sendit.cloud, tusfiles, userscloud), an XFileSharing site.
 * Free downloads without an account; with an account the XFS premium way.
 *
 * Reference: JD's SendNow.java (r52974, mirror 2026-09-28) on XFileSharingProBasic:
 * domains, name/size patterns (scanInfo), its checkErrors and isOffline additions, and the
 * connection limits (free: 1 chunk, premium: 10). JD's captcha info for the site: none.
 *
 * Folders (JD SendNowFolder, r52974): `/s/<…>` (or `/e/<…>`, loaded as `/s/`); every
 * `/<12-char id>` on the page is a file, names (`tx-dark`) and sizes (`label-success`) are taken
 * when there is one per link; further pages via the `page-link` to `?op=user_public…&page=N`.
 * The package is named after the rest of the folder URL, like JD.
 */
import { AccountError, decodeHtml, definePlugin, HosterLimitError, OfflineError, parseSize, PluginError, resolveUrl, TemporaryError } from '@haul/plugin-sdk';
import type { CrawledFile, Ctx } from '@haul/plugin-sdk';
import { createXfsPlugin, isApiAccount } from '@haul/plugin-sdk/xfs';

/** JD SendNow.getPluginDomains. */
const DOMAINS = ['send.now', 'send.cm', 'sendit.cloud', 'usersfiles.com', 'tusfiles.com', 'tusfiles.net', 'userscloud.com', 'usercdn.com'];
/** JD SendNowFolder: `https?://(?:www\.)?<domains>/(e|s)/(.+)`. */
const FOLDER = new RegExp(`^https?://(?:www\\.)?(?:${DOMAINS.map((d) => d.replace(/\./g, '\\.')).join('|')})/(?:e|s)/(.+)`, 'i');

/** JD SendNowFolder.decryptIt. */
async function crawlFolder(link: string, ctx: Ctx) {
  const rest = FOLDER.exec(link)![1];
  let res = await ctx.http.get(link.replace('/e/', '/s/'));
  if (res.status === 404 || />\s*Files not found/i.test(res.body)) {
    throw new OfflineError({ de: 'Send: Ordner nicht gefunden', en: 'Send: folder not found' });
  }
  const files: CrawledFile[] = [];
  const seen = new Set<string>();
  for (let page = 2; ; page++) {
    const links = [...res.body.matchAll(/(\/[a-z0-9]{12})/g)].map((m) => m[1]);
    if (!links.length) {
      throw new TemporaryError({ de: 'Send: keine Dateien im Ordner gefunden', en: 'Send: no files found in the folder' });
    }
    const names = [...res.body.matchAll(/class="tx-dark"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    const sizes = [...res.body.matchAll(/class="label label-success\s*"[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);
    let fresh = 0;
    links.forEach((path, i) => {
      if (seen.has(path)) return;
      seen.add(path);
      fresh++;
      files.push({
        url: resolveUrl(res.url, path),
        // Only when every link has one, as JD does.
        name: names.length === links.length ? decodeHtml(names[i]).trim() : undefined,
        size: sizes.length === links.length ? parseSize(sizes[i]) : undefined,
      });
    });
    if (!fresh) break;
    const next = new RegExp(
      `<a class\\s*=\\s*("|')page-link\\1[^>]*href\\s*=\\s*('|")(/\\?[^"']*op=user_public[^"']*page=${page})`,
      'i',
    ).exec(res.body)?.[3];
    if (!next) break;
    res = await ctx.http.get(resolveUrl(res.url, decodeHtml(next)));
  }
  let name = rest;
  try {
    name = decodeURIComponent(rest);
  } catch {
    /* keep it as it is */
  }
  return { packageName: decodeHtml(name).trim(), files };
}

const xfs = definePlugin(
  createXfsPlugin({
    id: 'send',
    name: 'Send',
    version: 10,
    // JD: getPluginDomains; usersfiles.com is dead (getDeadDomains), kept for old links.
    domains: DOMAINS,
    fileIdLength: 12,
    // JD SendNow: the XFS API (getAPIBase = main page + /api) with the user's API key.
    apiBase: 'https://send.now/api',
    userApiKeys: true,
    accountRequired: false,
    free: true,
    // JD: getMaxChunks() = 1 without account, -10 with premium.
    freeMaxConnections: 1,
    maxConnections: 10,
    // JD scanInfo, then the XFS defaults.
    namePatterns: [
      /class\s*=\s*"modal-title"\s*id="qr"[^>]*>\s*([^<]*?)\s*<\/h\d+>/i,
      /data-feather\s*=\s*"file"[^>]*>\s*<\/i>\s*([^<]*?)\s*<\/h\d+>/i,
      /&text=([^"]+)" target="_blank">\s*Share on Telegram/i,
      /class=["']file-info-name["'][^>]*>([^<]+)</i,
      /<input[^>]+name=["']fname["'][^>]+value=["']([^"']+)["']/i,
      /<h1[^>]*class=["'][^"']*file[^"']*["'][^>]*>([^<]+)</i,
    ],
    // JD SendNow.requestFileInformationWebsite (the MD5 there "doesn't match, maybe just fake").
    sha256Pattern: /SHA-256\s*:\s*<\/b>\s*([a-f0-9]{64})\s*<\/span>/i,
    sizePatterns: [
      /id="downloadbtn[^>]*><i [^>]*><\/i>\s*Download \[([^<\]]+)\]<\/button>/i,
      /<span[^>]+class=["'][^"']*file-size[^"']*["'][^>]*>([^<]+)</i,
      /\(\s*([\d.,]+\s*(?:B|KB|MB|GB|TB))\s*\)/i,
    ],
    checkErrors(html) {
      // JD 2024-06-24: "Not allowed", possibly premium-only files.
      if (/>\s*Not allowed/i.test(html)) {
        throw new PluginError('fatal', { de: 'Send: Seite meldet „Not allowed“', en: 'Send: the site says “Not allowed”' });
      }
      // JD 2025-08-07: "You can download up to 1 GB without an account" (ERROR_IP_BLOCKED).
      const limit = /(You can download up to[^<]*(?:<[^>]+>[^<]*){0,4}?without an account)/i.exec(html)?.[1];
      if (limit || />\s*You can download up to/i.test(html)) {
        const text = (limit ?? 'You can download up to …').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
        // JD: ERROR_IP_BLOCKED.
        throw new HosterLimitError(
          {
            de: `Send: Free-Limit erreicht („${text}“); später erneut oder mit Account`,
            en: `Send: free limit reached (“${text}”); later again or with an account`,
          },
          60 * 60,
        );
      }
      const premiumOnly = />\s*(This file is available for[^<]+)/i.exec(html)?.[1];
      if (premiumOnly) {
        throw new PluginError('fatal', { de: `Send: ${premiumOnly.trim()}`, en: `Send: ${premiumOnly.trim()}` });
      }
    },
  }),
);

const notAFile = () =>
  new PluginError('fatal', { de: 'Send: Ordner-Link, bitte neu hinzufügen', en: 'Send: folder link, please add it again' });

export default definePlugin({
  ...xfs,
  // JD SendNow.fetchAccountInfoAPI: the API only downloads with premium traffic.
  async checkAccount(ctx) {
    const info = await xfs.checkAccount!(ctx);
    const acc = ctx.account.get();
    if (acc && isApiAccount(acc.user) && !(info.trafficLeft && info.trafficLeft > 0)) {
      throw new AccountError({
        de: 'Send: über den API-Key lädt nur ein Premium-Account mit Direktlink-Traffic; sonst Benutzer und Passwort verwenden',
        en: 'Send: the API key only downloads with a premium account with direct link traffic; otherwise use user and password',
      });
    }
    return info;
  },
  matches: [...xfs.matches, FOLDER],
  // Folder links become their files; a file link stays as it is (checked later like before).
  async crawl(link, ctx) {
    if (FOLDER.test(link)) return crawlFolder(link, ctx);
    return { files: [{ url: link }] };
  },
  async check(link, ctx) {
    if (FOLDER.test(link)) throw notAFile();
    return xfs.check!(link, ctx);
  },
  async resolve(link, ctx) {
    if (FOLDER.test(link)) throw notAFile();
    return xfs.resolve(link, ctx);
  },
});
