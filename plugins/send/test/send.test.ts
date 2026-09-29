import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import type { HttpRequest } from '@haul/plugin-sdk';
import plugin from '../src/index';

const LINK = 'https://send.now/abcdefghijkl';
const OLD = 'https://send.cm/d/abcdefghijkl';
// XFS free pages as JD's XFileSharingProBasic handles them.
const PAGE1 = `<h3 class="modal-title" id="qr">Film.part1.rar</h3>
  <button id="downloadbtn" class="btn"><i class="x"></i> Download [1.5 GB]</button>
  <form method="POST" action=''>
    <input type="hidden" name="op" value="download1">
    <input type="hidden" name="usr_login" value="">
    <input type="hidden" name="id" value="abcdefghijkl">
    <input type="hidden" name="fname" value="Film.part1.rar">
    <input type="hidden" name="referer" value="">
    <input type="submit" name="method_free" value="Free Download">
    <input type="submit" name="method_premium" value="Premium Download">
  </form>`;
// Plain-text captcha: ordered by padding-left (6, 26, 46, 66) the digits read 7391.
const CAPTCHA = `<div style='width:80px;height:26px;font:bold 13px Arial;background:#ccc;text-align:left;direction:ltr;'>` +
  `<span style='position:absolute;padding-left:46px;padding-top:4px;'>&#57;</span>` +
  `<span style='position:absolute;padding-left:6px;padding-top:3px;'>&#55;</span>` +
  `<span style='position:absolute;padding-left:66px;padding-top:5px;'>&#49;</span>` +
  `<span style='position:absolute;padding-left:26px;padding-top:5px;'>&#51;</span></div>`;
const PAGE2 = (extra = CAPTCHA) => `<form name="F1" method="POST" action="">
    <input type="hidden" name="op" value="download2">
    <input type="hidden" name="id" value="abcdefghijkl">
    <input type="hidden" name="rand" value="r4nd">
    <input type="hidden" name="referer" value="">
    <input type="hidden" name="method_free" value="Free Download">
    <input type="hidden" name="method_premium" value="">
    <input type="hidden" name="adblock_detected" value="">
    ${extra}
    <input type="text" name="code" class="captcha_code">
    <span id="countdown_str">Wait <span id="cxc">5</span> seconds</span>
  </form>`;
const CDN = 'https://s3.usercdn.com/d/hash123/Film.part1.rar';

describe('send', () => {
  it('matches all its domains and is free', () => {
    const re = plugin.matches[0];
    for (const l of [LINK, OLD, 'https://tusfiles.com/abcdefghijkl', 'https://www.userscloud.com/abcdefghijkl']) expect(re.test(l)).toBe(true);
    expect(re.test('https://example.com/abcdefghijkl')).toBe(false);
    expect(plugin.accountRequired).toBe(false);
  });

  it('checks name and size like JD’s scanInfo', async () => {
    const ctx = fakeCtx({ 'GET https://send.now/abcdefghijkl': { body: PAGE1 } });
    expect(await plugin.check!(LINK, ctx)).toEqual({ online: true, name: 'Film.part1.rar', size: Math.round(1.5 * 1024 ** 3) });
  });

  it('downloads for free: download1, countdown, plain-text captcha, download2', async () => {
    const posts: HttpRequest[] = [];
    const ctx = fakeCtx({
      'GET https://send.now/abcdefghijkl': { body: PAGE1 },
      'POST https://send.now/abcdefghijkl': (req) => {
        posts.push(req);
        if (req.form?.op === 'download1') return { body: PAGE2() };
        return { status: 302, headers: { location: CDN } };
      },
    });
    const r = await plugin.resolve(OLD, ctx);
    expect(posts[0].form).toMatchObject({ op: 'download1', id: 'abcdefghijkl', method_free: 'Free Download' });
    expect(posts[0].form).not.toHaveProperty('method_premium');
    expect(posts[1].form).toMatchObject({ op: 'download2', rand: 'r4nd', code: '7391', adblock_detected: '0' });
    expect(ctx.waits).toHaveLength(1);
    expect(ctx.waits[0]).toBeGreaterThan(4);
    expect(r).toMatchObject({ url: CDN, name: 'Film.part1.rar', maxConnections: 1, headers: { Referer: LINK } });
  });

  it('waits exactly as long as the site says after a download', async () => {
    const ctx = fakeCtx({
      'GET https://send.now/abcdefghijkl': { body: '<div class="err">You have to wait 1 hour 5 minutes till next download</div>' },
    });
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'temporary', haulWait: 3901, haulScope: 'hoster' });
  });

  it('reports the free size limit with a wait (JD: IP blocked)', async () => {
    const ctx = fakeCtx({
      'GET https://send.now/abcdefghijkl': { body: PAGE1 },
      'POST https://send.now/abcdefghijkl': {
        body: `<div class="alert"></i> You can download up to&nbsp;<strong>1 GB</strong>&nbsp;without an account.&nbsp;<a href='/register'>Register</a></div>`,
      },
    });
    const e = await plugin.resolve(LINK, ctx).catch((x) => x);
    expect(e).toMatchObject({ haulKind: 'temporary', haulWait: 3600, haulScope: 'hoster' });
    expect(e.message).toContain('1 GB');
  });

  it('has the user solve a reCaptcha and posts the token', async () => {
    const ctx = fakeCtx({
      'GET https://send.now/abcdefghijkl': { body: PAGE1 },
      'POST https://send.now/abcdefghijkl': (req) =>
        req.form?.op === 'download1'
          ? { body: PAGE2('<div class="g-recaptcha" data-sitekey="6Lx"></div>') }
          : (expect(req.form?.['g-recaptcha-response']).toBe('CAPTCHA-TOKEN'), { status: 302, headers: { location: CDN } }),
    });
    expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
    expect(ctx.captchas).toEqual([{ kind: 'recaptcha', siteKey: '6Lx', pageUrl: LINK }]);
  });

  it('stops on image captchas', async () => {
    const ctx = fakeCtx({
      'GET https://send.now/abcdefghijkl': { body: PAGE1 },
      'POST https://send.now/abcdefghijkl': { body: PAGE2('<img src="/captchas/abc.jpg">') },
    });
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'fatal', message: expect.stringContaining('Bild-Captcha') });
  });

  it('knows its offline and premium-only pages', async () => {
    const gone = fakeCtx({ 'GET https://send.now/abcdefghijkl': { body: "<h2> The file you were looking for doesn't exist</h2>" } });
    await expect(plugin.resolve(LINK, gone)).rejects.toMatchObject({ haulKind: 'offline' });
    expect((await plugin.check!(LINK, gone)).online).toBe(false);
    const premium = fakeCtx({ 'GET https://send.now/abcdefghijkl': { body: '<p> This file is available for Premium Users only</p>' } });
    await expect(plugin.resolve(LINK, premium)).rejects.toMatchObject({ haulKind: 'fatal' });
  });

  it('takes a direct redirect on the first page', async () => {
    const ctx = fakeCtx({ 'GET https://send.now/abcdefghijkl': { status: 302, headers: { location: CDN } } });
    expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
  });

  it('uses the premium way with an account', async () => {
    const ctx = fakeCtx(
      {
        'GET https://send.now/abcdefghijkl': { body: `<a href="/?op=logout">Logout</a>${PAGE2('')}` },
        'POST https://send.now/abcdefghijkl': (req) => {
          expect(req.form?.method_premium).toBe('Premium Download');
          return { status: 302, headers: { location: CDN } };
        },
      },
      { id: 1, user: 'bob', secret: 'xfss=SESSION' },
    );
    expect(await plugin.resolve(LINK, ctx)).toMatchObject({ url: CDN, maxConnections: 10 });
  });
});
