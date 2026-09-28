/**
 * ddownload.com (formerly ddl.to), an XFileSharing site. Premium only in v1.
 *
 * Account: user + password like in JDownloader. ddownload protects its login form with a
 * Cloudflare Turnstile captcha, which a headless server cannot solve; in that case the
 * session cookie `xfss` from a browser login is entered as the password (`xfss=…`).
 *
 * Patterns and limits follow JD's DdownloadCom.java / XFileSharingProBasic.java and pyLoad's
 * DdownloadCom plugins.
 */
import { definePlugin, parseSize } from '@haul/plugin-sdk';
import { createXfsPlugin } from '@haul/plugin-sdk/xfs';

export default definePlugin(
  createXfsPlugin({
    id: 'ddownload',
    name: 'ddownload',
    version: 4,
    domains: ['ddownload.com', 'ddl.to'],
    fileIdLength: 12,
    apiBase: 'https://api-v2.ddownload.com/api',
    // ddownload's API key belongs to the app, not the user; accounts log in via the website.
    userApiKeys: false,
    accountRequired: true,
    // JD: getMaxChunks() = 1 for premium too; more connections end in HTTP 503.
    maxConnections: 1,
    downloadHosts: ['ucdn.to'],
    premiumPattern: /ma-ultimate-pill[^>]*>\s*Ultimate\s*</i,
    validUntilPatterns: [/>\s*Active until\s+([^<]+?)\s*</i],
    trafficLeft: (html) => {
      // Shown in MB on the dashboard; pyLoad converts it the same way to match the site.
      const m = /<span id=["']trafficValue["']>\s*(-?\d+)\s*<\/span>/i.exec(html);
      if (m) return Math.max(0, Math.round((Number(m[1]) / 1000) * 1024 ** 3));
      // Older layout, as matched by JD: <span>Traffic available</span><div class="price"><sup>GB</sup>187</div>
      const old = /<span>Traffic available<\/span>\s*<div class="price"><sup>([^<>]+)<\/sup>(-?\d+)<\/div>/i.exec(html);
      return old ? Math.max(0, parseSize(`${old[2]} ${old[1]}`) ?? 0) : undefined;
    },
  }),
);
