import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import type { HttpRequest } from '@haul/plugin-sdk';
import plugin from '../src/index';

const LINK = 'https://fileq.net/abcdefghijkl/Film.part1.rar.html';
const PAGE = 'https://fileq.net/abcdefghijkl';
const PAGE1 = `<h1 class="file-title">Film.part1.rar</h1><span class="file-size">1.5 GB</span>
  <form method="POST" action="">
    <input type="hidden" name="op" value="download1">
    <input type="hidden" name="id" value="abcdefghijkl">
    <input type="hidden" name="fname" value="Film.part1.rar">
    <input type="submit" name="method_free" value="Free Download">
  </form>`;
// The XFS plain-text captcha: digits placed by their padding (JD handleCaptcha).
const DIGITS = [
  [30, '&#51;'],
  [0, '&#52;'],
  [10, '&#49;'],
  [20, '&#56;'],
]
  .map(([x, d]) => `<span style='position:absolute;padding-left:${x}px;padding-top:3px;'>${d}</span>`)
  .join('');
const PAGE2 = `<span id="countdown_str">Wait <span id="cd">5</span> seconds</span>
  <form name="F1" method="POST" action="">
    <input type="hidden" name="op" value="download2">
    <input type="hidden" name="id" value="abcdefghijkl">
    <input type="hidden" name="rand" value="r4nd">
    <input type="hidden" name="method_free" value="Free Download">
    <div style="width:80px;height:26px;font:bold 13px Arial;background:#ccc;text-align:left;direction:ltr;">${DIGITS}</div>
    <input type="text" name="code">
  </form>`;
const CDN = 'https://s1.fileq.net/d/hash/Film.part1.rar';

describe('fileq', () => {
  it('takes fileq.net links, with or without a name', () => {
    const re = plugin.matches as RegExp[];
    expect(re.some((r) => r.test(LINK))).toBe(true);
    expect(re.some((r) => r.test('https://www.fileq.net/abcdefghijkl'))).toBe(true);
    expect(re.some((r) => r.test('https://fileq.com/abcdefghijkl'))).toBe(false);
  });

  it('checks name and size with the XFS defaults', async () => {
    const ctx = fakeCtx({ [`GET ${PAGE}`]: { body: PAGE1 } });
    expect(await plugin.check!(LINK, ctx)).toMatchObject({ name: 'Film.part1.rar', size: 1.5 * 1024 ** 3 });
  });

  it("falls back to pyLoad's BBCode name", async () => {
    const page = `<textarea onfocus="copy(this)">[URL=https://fileq.net/abcdefghijkl]Other.Name.mkv -  734003200[/URL]</textarea>`;
    const ctx = fakeCtx({ [`GET ${PAGE}`]: { body: page } });
    expect((await plugin.check!(LINK, ctx)).name).toBe('Other.Name.mkv');
  });

  it('downloads the XFS free way, reading the plain-text captcha, with one connection', async () => {
    const posts: HttpRequest[] = [];
    const ctx = fakeCtx({
      [`GET ${PAGE}`]: { body: PAGE1 },
      [`POST ${PAGE}`]: (req) => {
        posts.push(req);
        return req.form?.op === 'download1' ? { body: PAGE2 } : { status: 302, headers: { location: CDN } };
      },
    });
    const r = await plugin.resolve(LINK, ctx);
    expect(posts[0].form).toMatchObject({ op: 'download1', id: 'abcdefghijkl', method_free: 'Free Download' });
    expect(posts[1].form).toMatchObject({ op: 'download2', id: 'abcdefghijkl', rand: 'r4nd', code: '4183' });
    expect(ctx.waits[0]).toBeGreaterThan(4);
    expect(r).toMatchObject({ url: CDN, maxConnections: 1 });
  });
});
