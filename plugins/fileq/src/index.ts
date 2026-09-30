/**
 * fileq.net, an XFileSharing site: free downloads without an account, premium with one.
 *
 * Reference: JD's FileqNet.java (r52238, mirror 2026-09-28) on XFileSharingProBasic: only the
 * domain and the limits, everything else is the XFS default (download1/download2, countdown,
 * captchas, website login). Limits: no plugin connection limit (JD getMaxChunks 0), which in JD
 * means its default of one per file; free downloads use one here too (the server refuses a second
 * with 503), premium the plugin's limit. Any number of downloads at once, resumable.
 *
 * Cross-checked with pyLoad's FileqNet.py (0.02): links are `fileq.net/<12-char id>`; its name
 * pattern (the BBCode copy field) is kept after JD's as a fallback. Its size pattern takes only
 * the digits before a unit, so it is left out.
 *
 * Captchas: whatever the page shows goes the XFS way (plain-text digits read from the page,
 * image typed in Haul, reCaptcha/hCaptcha/Turnstile solved in the browser).
 */
import { definePlugin } from '@haul/plugin-sdk';
import { createXfsPlugin, DEFAULT_NAMES } from '@haul/plugin-sdk/xfs';

export default definePlugin(
  createXfsPlugin({
    id: 'fileq',
    name: 'FileQ',
    version: 5,
    domains: ['fileq.net'],
    fileIdLength: 12,
    accountRequired: false,
    free: true,
    // JD: getMaxChunks() = 0, i.e. no limit from the plugin; JD then takes its own default of
    // one connection per file (GeneralSettings.getMaxChunksPerFile = 1), and that is what free
    // downloads get there. fileq.net's free server answers a second connection with 503
    // (2026-09), so one without an account; with premium the plugin's "no limit".
    freeMaxConnections: 1,
    maxConnections: 16,
    // JD scanInfo (the XFS defaults), then pyLoad's INFO_PATTERN.
    namePatterns: [...DEFAULT_NAMES, /onfocus="copy\(this\)">\[URL=[^\]]+\](.+?) - {2}\d/i],
  }),
);
