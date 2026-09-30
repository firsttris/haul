/**
 * datanodes.to, an XFileSharing site: free downloads without an account.
 *
 * Reference: JD's DatanodesTo.java (r53121, mirror 2026-09-28) on XFileSharingProBasic:
 * - download1 is the form `downloadForm`;
 * - download2 gets `g_captch__a=1`; when the page builds it with JavaScript, JD writes it
 *   itself from `rand="…"`, `dl-token="…"` and `captcha-html="…"`;
 * - the countdown is the attribute `countdown="N"`;
 * - the answer to download2 can be JSON `{"url": …}` (possibly URL-encoded, with line breaks);
 * - a simple referer protection: every request says it comes from https://datanodes.to/users;
 * - "Not allowed from domain you're coming from", and "/premium" without any download form
 *   means premium only;
 * - no connection limit (JD getMaxChunks 0);
 * - captchas (JD handleCaptcha): `g-recaptcha-response` in the page means reCaptcha v2, which the
 *   user solves in the browser; its key may also come from a script (`grecaptcha.render`), which
 *   the XFS base searches then. Anything else goes the XFS default way.
 * - download1 without a `method_free` value gets "Free Download" (JD findFormDownload1Free);
 *   the XFS base does that for every site.
 * Not taken over: JD gives Datanodes a random User-Agent (`UserAgents.generate()`, no reason in
 * the source; the only JD plugin that does so).
 */
import { decodeHtml, definePlugin, parseForms, PluginError } from '@haul/plugin-sdk';
import { createXfsPlugin } from '@haul/plugin-sdk/xfs';
import type { FreeStep } from '@haul/plugin-sdk/xfs';

const SITE = 'https://datanodes.to';

export default definePlugin(
  createXfsPlugin({
    id: 'datanodes',
    name: 'Datanodes',
    version: 8,
    domains: ['datanodes.to'],
    fileIdLength: 12,
    accountRequired: false,
    free: true,
    freeMaxConnections: 16,
    maxConnections: 16,
    headers: { Referer: `${SITE}/users` },
    // JD scanInfo 2026-04-20, then the XFS defaults.
    namePatterns: [
      /file-actions link="https?:\/\/[^/]+\/[a-z0-9]{12}\/([^/"]+)"/i,
      /class=["']file-info-name["'][^>]*>([^<]+)</i,
      /<input[^>]+name=["']fname["'][^>]+value=["']([^"']+)["']/i,
      /<h1[^>]*class=["'][^"']*file[^"']*["'][^>]*>([^<]+)</i,
      /<title>\s*Download\s+([^<]+?)\s*<\/title>/i,
    ],
    checkErrors(html) {
      if (/>\s*Not allowed from domain you/i.test(html)) {
        throw new PluginError('fatal', {
          de: 'Datanodes: „Not allowed from domain you’re coming from“',
          en: 'Datanodes: “Not allowed from domain you’re coming from”',
        });
      }
      // JD isPremiumOnly: a /premium link and no download form at all.
      const forms = parseForms(html);
      const hasDownloadForm = forms.some((f) => /id=["']downloadForm["']/i.test(f.html) || (f.fields.op ?? '').startsWith('download'));
      if (/\/premium/i.test(html) && !hasDownloadForm && !/countdown="\d+"/i.test(html)) {
        throw new PluginError('fatal', { de: 'Datanodes: nur mit Premium', en: 'Datanodes: premium only' });
      }
    },
    freeHooks: {
      download1(page) {
        const form = parseForms(page.body).find((f) => /id=["']downloadForm["']/i.test(f.html)) ??
          parseForms(page.body).find((f) => f.fields.op === 'download1');
        return form && { fields: { ...form.fields }, action: form.action ?? undefined, html: form.html };
      },
      download2(page, fileId, found): FreeStep | undefined {
        if (found) return { ...found, fields: { ...found.fields, g_captch__a: '1' } };
        // JD: the form comes via JavaScript; with a countdown on the page, build it.
        if (!/countdown="\d+"/i.test(page.body)) return undefined;
        const rand = /rand="([^"]+)"/i.exec(page.body)?.[1] ?? '';
        const token = /dl-token="([^"]+)"/i.exec(page.body)?.[1];
        const captcha = /captcha-html="(.*?)"/i.exec(page.body)?.[1];
        const fields: Record<string, string> = {
          op: 'download2',
          g_captch__a: '1',
          id: fileId,
          rand,
          ...(token ? { dl_token: token } : {}),
          referer: page.url,
          method_free: 'Free Download >>',
          method_premium: '',
        };
        return { fields, html: captcha ? decodeHtml(captcha) : '' };
      },
      countdown: (html) => {
        const n = /countdown="(\d+)"/i.exec(html)?.[1];
        return n ? Number(n) : undefined;
      },
      directLink(res) {
        const body = res.body.trim();
        if (!body.startsWith('{')) return undefined;
        try {
          let url = (JSON.parse(body) as { url?: string }).url;
          if (!url) return undefined;
          if (/^https%3A%2F/i.test(url)) url = decodeURIComponent(url);
          return url.replace(/[\r\n]/g, '');
        } catch {
          return undefined;
        }
      },
    },
  }),
);
