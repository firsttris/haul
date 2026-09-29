/**
 * ddownload.com (formerly ddl.to), an XFileSharing site. Premium only in v1.
 *
 * Account: user + password like in JDownloader. If ddownload shows a Cloudflare Turnstile
 * captcha at login (it does for browser User-Agents), the session cookie `xfss` from a browser
 * login is entered as the password (`xfss=…`). The session is kept across restarts.
 *
 * Reference: JD's DdownloadCom.java (SVN r53187, 2026-08) and XFileSharingProBasic.java,
 * plus pyLoad's DdownloadCom plugins. JD sends the User-Agent "JDownloader2" to ddownload
 * (requested by their admin) and gets no login captcha; see HAUL_USER_AGENT.
 */
import { definePlugin, parseSize } from '@haul/plugin-sdk';
import { createXfsPlugin } from '@haul/plugin-sdk/xfs';

export default definePlugin(
  createXfsPlugin({
    id: 'ddownload',
    name: 'ddownload',
    version: 5,
    domains: ['ddownload.com', 'ddl.to'],
    fileIdLength: 12,
    apiBase: 'https://api-v2.ddownload.com/api',
    // JD: API downloads were turned off by the admins (2024-11-28); accounts use the website.
    userApiKeys: false,
    accountRequired: true,
    // JD: getMaxChunks() = 1 for free and premium.
    maxConnections: 1,
    downloadHosts: ['ucdn.to'],
    // Site redesign 2026 (JD: "current-2026-04"), then older layouts.
    namePatterns: [
      /class=["'][^"']*dk-dl-name["'][^>]*>\s*([^<]+?)\s*</i,
      /<h1[^>]*class=["']file-info-name["'][^>]*>([^<]+)<\/h1>/i,
      /class=["'][^"']*\bfilename["'][^>]*>\s*([^<]+?)\s*</i,
      /class=["'][^"']*dl-file-name["'][^>]*>\s*([^<]+?)\s*</i,
      /<div class=["']name position-relative["']>\s*<h4>([^<>"]+)<\/h4>/i,
    ],
    sizePatterns: [
      /class=["'][^"']*dk-dl-size["'][^>]*>\s*([^<]+?)\s*</i,
      /class=["'](?:dl-)?file-size["']>([^<>"]+)</i,
      /\[<font[^>]*>(\d+[^<>"]+)<\/font>\]/i,
      /class=["'][^"']*\bfilesize["'][^>]*>\s*([^<]+?)\s*</i,
    ],
    premiumPattern: /ma-ultimate-pill[^>]*>\s*Ultimate\s*</i,
    validUntilPatterns: [/>\s*Active until\s+([^<]+?)\s*</i],
    trafficLeft: (html) => {
      // JD 2026-03: <div data-traffic="187000"> in MB (decimal); can be negative.
      const data = /data-traffic=["'](-?\d+)["']/i.exec(html);
      if (data) return Math.max(0, Number(data[1]) * 1000 * 1000);
      // pyLoad: <span id="trafficValue">187000</span>, shown as MB.
      const m = /<span id=["']trafficValue["']>\s*(-?\d+)\s*<\/span>/i.exec(html);
      if (m) return Math.max(0, Math.round((Number(m[1]) / 1000) * 1024 ** 3));
      // Older layout: <span>Traffic available</span><div class="price"><sup>GB</sup>187</div>
      const old = /<span>Traffic available<\/span>\s*<div class="price"><sup>([^<>]+)<\/sup>(-?\d+)<\/div>/i.exec(html);
      return old ? Math.max(0, parseSize(`${old[2]} ${old[1]}`) ?? 0) : undefined;
    },
  }),
);
