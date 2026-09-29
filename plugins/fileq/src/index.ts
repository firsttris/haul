/**
 * fileq.net, an XFileSharing site: free downloads without an account, premium with one.
 *
 * Reference: JD's FileqNet.java (r52238, mirror 2026-09-28) on XFileSharingProBasic: only the
 * domain and the limits, everything else is the XFS default (download1/download2, countdown,
 * captchas, website login). Limits: no connection limit for free, free account and premium
 * (JD getMaxChunks 0), any number of downloads at once, resumable.
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
    version: 2,
    domains: ['fileq.net'],
    fileIdLength: 12,
    accountRequired: false,
    free: true,
    // JD: getMaxChunks() = 0 (no limit) for all account types.
    freeMaxConnections: 16,
    maxConnections: 16,
    // JD scanInfo (the XFS defaults), then pyLoad's INFO_PATTERN.
    namePatterns: [...DEFAULT_NAMES, /onfocus="copy\(this\)">\[URL=[^\]]+\](.+?) - {2}\d/i],
  }),
);
