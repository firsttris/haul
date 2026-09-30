import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import type { HttpRequest } from '@haul/plugin-sdk';
import plugin from '../src/index';

const LINK = 'https://filekeeper.net/abcdefghijkl';
const PAGE1 = `<h1 class="file-title">Film part1</h1>
  <div class="share" link="https://filekeeper.net/abcdefghijkl/Film.part1.rar"></div>
  <form method="POST" action="">
    <input type="hidden" name="op" value="download1">
    <input type="hidden" name="id" value="abcdefghijkl">
    <input type="submit" name="method_free" value="Free Download">
  </form>`;
// download2 comes via JavaScript (JD findFormDownload2Free builds it); reCaptcha since 2026-01.
const PAGE2_JS = `<div class="dl" data-countdown="6" data-code="abcdefghijkl"></div>
  <div class="g-recaptcha" data-sitekey="6LfKeeper"></div>
  <script>$.post('', { 'op': 'download2', 'id': code, 'rand': '', 'method_free': 'Free download' });</script>`;
const CDN = 'https://fs3.filekeeper.net/d/hash/Film.part1.rar';

describe('filekeeper', () => {
  it('takes the name from the link attribute (JD scanInfo)', async () => {
    const ctx = fakeCtx({ [`GET ${LINK}`]: { body: PAGE1 } });
    expect((await plugin.check!(LINK, ctx)).name).toBe('Film.part1.rar');
  });

  it('builds download2 like JD, waits data-countdown and has the user solve the reCaptcha', async () => {
    const posts: HttpRequest[] = [];
    const ctx = fakeCtx({
      [`GET ${LINK}`]: { body: PAGE1 },
      [`POST ${LINK}`]: (req) => {
        posts.push(req);
        return req.form?.op === 'download1' ? { body: PAGE2_JS } : { status: 302, headers: { location: CDN } };
      },
    });
    const r = await plugin.resolve(LINK, ctx);
    expect(posts[0].form).toMatchObject({ op: 'download1', id: 'abcdefghijkl', method_free: 'Free Download' });
    expect(posts[1].form).toEqual({
      op: 'download2',
      id: 'abcdefghijkl',
      rand: '',
      referer: '',
      method_free: 'Free download',
      down_direct: '1',
      'g-recaptcha-response': 'CAPTCHA-TOKEN',
    });
    expect(ctx.captchas[0]).toMatchObject({ kind: 'recaptcha', siteKey: '6LfKeeper', pageUrl: LINK });
    expect(ctx.waits[0]).toBeGreaterThan(5);
    expect(r).toMatchObject({ url: CDN, name: 'Film.part1.rar', maxConnections: 1 });
  });

  it('keeps a real download2 form when the page has one', async () => {
    const page2 = `<form name="F1" method="POST" action=""><input type="hidden" name="op" value="download2">
      <input type="hidden" name="id" value="abcdefghijkl"><input type="hidden" name="rand" value="x"></form>`;
    const ctx = fakeCtx({
      [`GET ${LINK}`]: { body: PAGE1 },
      [`POST ${LINK}`]: (req) =>
        req.form?.op === 'download1'
          ? { body: page2 }
          : (expect(req.form).toMatchObject({ op: 'download2', rand: 'x' }), expect(req.form?.down_direct).toBeUndefined(), { status: 302, headers: { location: CDN } }),
    });
    expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
  });
});
