/**
 * filekeeper.net, an XFileSharing site: free downloads without an account, premium with one.
 *
 * Reference: JD's FilekeeperNet.java (r52198, mirror 2026-09-28) on XFileSharingProBasic:
 * - the countdown is the attribute `data-countdown="N"` (JD regexWaittime), else the default;
 * - download2 (JD findFormDownload2Free): the default form if there is one; otherwise the page
 *   builds it with JavaScript (`'op': 'download2'`), and JD posts `op=download2`, the id from
 *   `data-code="…"`, empty `rand` and `referer`, `method_free=Free download`, `down_direct=1`;
 * - the name from `link="https://…/<12-char id>/<name>"` beats the defaults (JD scanInfo);
 * - no connection limit (JD getMaxChunks 0), any number of downloads at once, resumable.
 *
 * Since 2026-01 free downloads show a reCaptcha: solved in the browser with the userscript.
 * pyLoad has no plugin for the site.
 */
import { definePlugin } from '@haul/plugin-sdk';
import { createXfsPlugin, DEFAULT_NAMES } from '@haul/plugin-sdk/xfs';
import type { FreeStep } from '@haul/plugin-sdk/xfs';

export default definePlugin(
  createXfsPlugin({
    id: 'filekeeper',
    name: 'Filekeeper',
    version: 1,
    domains: ['filekeeper.net'],
    fileIdLength: 12,
    accountRequired: false,
    free: true,
    // JD: getMaxChunks() = 0 (no limit) for all account types.
    freeMaxConnections: 16,
    maxConnections: 16,
    // JD scanInfo: the name in the `link` attribute wins, then the defaults.
    namePatterns: [/link="https?:\/\/[^/]+\/[a-z0-9]{12}\/([^"/]+)"/i, ...DEFAULT_NAMES],
    freeHooks: {
      download2(page, _fileId, found): FreeStep | undefined {
        if (found) return found;
        const id = /data-code="([a-z0-9]+)/i.exec(page.body)?.[1];
        if (!id || !page.body.includes("'op': 'download2'")) return undefined;
        return {
          fields: { op: 'download2', id, rand: '', referer: '', method_free: 'Free download', down_direct: '1' },
          // The reCaptcha sits elsewhere on the page; the XFS base looks there too.
          html: '',
        };
      },
      countdown(html) {
        const n = /data-countdown="(\d+)"/i.exec(html)?.[1];
        return n ? Number(n) : undefined;
      },
    },
  }),
);
