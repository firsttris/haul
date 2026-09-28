/**
 * ddownload.com (formerly ddl.to), an XFileSharing site. Premium only in v1.
 *
 * Account: user + password like in JDownloader. ddownload protects its login form with a
 * Cloudflare Turnstile captcha, which a headless server cannot solve; in that case the
 * session cookie `xfss` from a browser login is entered as the password (`xfss=…`).
 *
 * Patterns follow pyLoad's DdownloadCom downloader and account plugins.
 */
import { definePlugin } from '@haul/plugin-sdk';
import { createXfsPlugin } from '@haul/plugin-sdk/xfs';

export default definePlugin(
  createXfsPlugin({
    id: 'ddownload',
    name: 'ddownload',
    version: 2,
    domains: ['ddownload.com', 'ddl.to'],
    fileIdLength: 12,
    apiBase: 'https://api-v2.ddownload.com/api',
    // ddownload's API key belongs to the app, not the user; accounts log in via the website.
    userApiKeys: false,
    accountRequired: true,
    maxConnections: 4,
    premiumPattern: /ma-ultimate-pill[^>]*>\s*Ultimate\s*</i,
    validUntilPatterns: [/>\s*Active until\s+([^<]+?)\s*</i],
    // Shown in MB on the dashboard; pyLoad converts it the same way to match the site.
    trafficLeft: (html) => {
      const m = /<span id=["']trafficValue["']>\s*(-?\d+)\s*<\/span>/i.exec(html);
      return m ? Math.max(0, Math.round((Number(m[1]) / 1000) * 1024 ** 3)) : undefined;
    },
  }),
);
