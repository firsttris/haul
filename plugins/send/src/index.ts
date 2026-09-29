/**
 * send.now (formerly send.cm, sendit.cloud, tusfiles, userscloud), an XFileSharing site.
 * Free downloads without an account; with an account the XFS premium way.
 *
 * Reference: JD's SendNow.java (r52974, mirror 2026-09-28) on XFileSharingProBasic:
 * domains, name/size patterns (scanInfo), its checkErrors and isOffline additions, and the
 * connection limits (free: 1 chunk, premium: 10). JD's captcha info for the site: none.
 */
import { definePlugin, HosterLimitError, PluginError } from '@haul/plugin-sdk';
import { createXfsPlugin } from '@haul/plugin-sdk/xfs';

export default definePlugin(
  createXfsPlugin({
    id: 'send',
    name: 'Send',
    version: 2,
    // JD: getPluginDomains; usersfiles.com is dead (getDeadDomains), kept for old links.
    domains: ['send.now', 'send.cm', 'sendit.cloud', 'usersfiles.com', 'tusfiles.com', 'tusfiles.net', 'userscloud.com', 'usercdn.com'],
    fileIdLength: 12,
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
