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

  it('passes on the SHA-256 of the file page (JD SendNow)', async () => {
    const sha = 'ab'.repeat(32);
    const page = PAGE1 + `<span><b>SHA-256 :</b> ${sha}</span>`;
    const ctx = fakeCtx({
      'GET https://send.now/abcdefghijkl': { body: page },
      'POST https://send.now/abcdefghijkl': (req) => (req.form?.op === 'download1' ? { body: PAGE2() } : { status: 302, headers: { location: CDN } }),
    });
    expect((await plugin.check!(LINK, ctx)).hash).toEqual({ type: 'sha256', value: sha });
    expect((await plugin.resolve(LINK, ctx)).hash).toEqual({ type: 'sha256', value: sha });
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

  it('sends the download password and asks again when it was wrong (JD handlePassword)', async () => {
    // XFS markup JD's isPasswordProtectedHTML looks for.
    const PW = '<br><b>Password:</b> <input type="password" name="password" class="myForm">';
    const sent: string[] = [];
    const ctx = fakeCtx({
      'GET https://send.now/abcdefghijkl': { body: PAGE1 },
      'POST https://send.now/abcdefghijkl': (req) => {
        if (req.form?.op === 'download1') return { body: PAGE2(PW + CAPTCHA) };
        sent.push(req.form!.password);
        expect(req.form).toMatchObject({ op: 'download2', code: '7391' });
        if (req.form!.password !== 'geheim') return { body: `<div class="err">Wrong password</div>${PAGE2(PW + CAPTCHA)}` };
        return { status: 302, headers: { location: CDN } };
      },
    });
    ctx.savedPassword = 'alt';
    ctx.passwordAnswers = ['geheim'];
    expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
    expect(sent).toEqual(['alt', 'geheim']);
    expect(ctx.passwordAsks).toEqual([{ wrong: true }]);
    expect(ctx.savedPassword).toBe('geheim');
  });

  it('does not ask for a password the page does not want', async () => {
    const ctx = fakeCtx({
      'GET https://send.now/abcdefghijkl': { body: PAGE1 },
      'POST https://send.now/abcdefghijkl': (req) => {
        if (req.form?.op === 'download1') return { body: PAGE2() };
        expect(req.form).not.toHaveProperty('password');
        return { body: '<div class="err">Wrong password</div>' };
      },
    });
    // JD: the site says "wrong password" without having asked for one → temporary.
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'temporary' });
    expect(ctx.passwordAsks).toEqual([]);
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

  it('has the user type an image captcha (JD "Standard captcha")', async () => {
    const posts: HttpRequest[] = [];
    const ctx = fakeCtx({
      'GET https://send.now/abcdefghijkl': { body: PAGE1 },
      'POST https://send.now/abcdefghijkl': (req) => {
        posts.push(req);
        if (req.form?.op === 'download1') return { body: PAGE2('<img src="/captchas/abc123.jpg">') };
        return { status: 302, headers: { location: CDN } };
      },
    });
    ctx.captchaToken = 'x7k2';
    expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
    expect(ctx.captchas).toEqual([{ kind: 'image', imageUrl: 'https://send.now/captchas/abc123.jpg', pageUrl: LINK, headers: undefined }]);
    expect(posts[1].form).toMatchObject({ op: 'download2', code: 'x7k2' });
  });

  it('takes an absolute captcha picture link first', async () => {
    const ctx = fakeCtx({
      'GET https://send.now/abcdefghijkl': { body: PAGE1 },
      'POST https://send.now/abcdefghijkl': (req) =>
        req.form?.op === 'download1'
          ? { body: PAGE2('<img src="https://img.send.now/captchas/q9.png?x=1&amp;y=2">') }
          : { status: 302, headers: { location: CDN } },
    });
    await plugin.resolve(LINK, ctx);
    expect(ctx.captchas[0]).toMatchObject({ kind: 'image', imageUrl: 'https://img.send.now/captchas/q9.png?x=1&y=2' });
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

  describe('folders (JD SendNowFolder)', () => {
    const row = (id: string, name: string, size: string) =>
      `<tr><td><a href="https://send.now/${id}" class="tx-dark">${name}</a></td><td><span class="label label-success ">${size}</span></td></tr>`;
    const PAGE_1 = `<table>${row('aaaaaaaaaaa1', 'Film.part1.rar', '1.5 GB')}${row('aaaaaaaaaaa2', 'Film &amp; Co.part2.rar', '500 MB')}</table>
      <ul class="pagination"><li><a class='page-link' href='/?op=user_public&amp;usr_login=bob&amp;fld_id=7&amp;page=2'>2</a></li></ul>`;
    const PAGE_2 = `<table>${row('aaaaaaaaaaa3', 'Film.part3.rar', '10 KB')}</table>
      <ul class="pagination"><li><a class='page-link' href='/?op=user_public&amp;usr_login=bob&amp;fld_id=7&amp;page=1'>1</a></li></ul>`;

    it('lists the files of every page and names the package', async () => {
      const ctx = fakeCtx({
        'GET https://send.now/s/bob/7/My%20Film': { body: PAGE_1 },
        'GET https://send.now/?op=user_public&usr_login=bob&fld_id=7&page=2': { body: PAGE_2 },
      });
      // /e/ is loaded as /s/.
      expect(await plugin.crawl!('https://send.now/e/bob/7/My%20Film', ctx)).toEqual({
        packageName: 'bob/7/My Film',
        files: [
          { url: 'https://send.now/aaaaaaaaaaa1', name: 'Film.part1.rar', size: Math.round(1.5 * 1024 ** 3) },
          { url: 'https://send.now/aaaaaaaaaaa2', name: 'Film & Co.part2.rar', size: 500 * 1024 ** 2 },
          { url: 'https://send.now/aaaaaaaaaaa3', name: 'Film.part3.rar', size: 10 * 1024 },
        ],
      });
    });

    it('reports a missing folder as offline', async () => {
      const ctx = fakeCtx({ 'GET https://send.now/s/x': { body: '<h3> Files not found</h3>' } });
      await expect(plugin.crawl!('https://send.now/s/x', ctx)).rejects.toMatchObject({ haulKind: 'offline' });
    });

    it('keeps file links as they are, without a request', async () => {
      const ctx = fakeCtx({});
      expect(await plugin.crawl!(LINK, ctx)).toEqual({ files: [{ url: LINK }] });
      expect(plugin.matches.some((re) => re.test('https://send.now/s/bob'))).toBe(true);
      await expect(plugin.resolve('https://send.now/s/bob', ctx)).rejects.toMatchObject({ haulKind: 'fatal' });
    });
  });

  describe('API-key account (JD SendNow)', () => {
    const info = (result: object) => ({
      'GET https://send.now/api/account/info?key=abcdefghij0123456789': { body: JSON.stringify({ status: 200, result }) },
    });
    const acc = { id: 3, user: '', secret: 'abcdefghij0123456789' };

    it('accepts premium with direct link traffic', async () => {
      const ctx = fakeCtx(info({ premium_expire: '2099-01-01 00:00:00', premium_bandwidth: '100 GB' }), acc);
      expect(await plugin.checkAccount!(ctx)).toMatchObject({ valid: true, premium: true, trafficLeft: 100 * 1024 ** 3 });
    });

    it('refuses the API without premium traffic, like JD', async () => {
      const ctx = fakeCtx(info({ premium_expire: '2020-01-01 00:00:00' }), acc);
      await expect(plugin.checkAccount!(ctx)).rejects.toMatchObject({ haulKind: 'account' });
    });

    it('downloads premium through file/direct_link', async () => {
      const ctx = fakeCtx(
        { 'GET https://send.now/api/file/direct_link?key=abcdefghij0123456789&file_code=abcdefghijkl': { body: JSON.stringify({ status: 200, result: { url: CDN } }) } },
        acc,
      );
      expect((await plugin.resolve(LINK, ctx)).url).toBe(CDN);
    });
  });

  describe('short links and the security verification (send.now 2026-09)', () => {
    // The page as send.now serves it (trimmed): form F1 = download1 with a Turnstile widget.
    const CHALLENGE = `<title> Download Challenge</title>
      <input type="hidden" id="turnstile_callback" name="turnstile_callback" >
      <form name="F1" method="POST" action="">
      <input type="hidden" name="op" value="download1">
      <input type="hidden" name="id" value="abcdefghijkl">
      <input type="hidden" name="rand" value="">
      <input type="hidden" name="referer" value="">
      <div class="cf-turnstile" data-sitekey="0x4AAAAAABrUKnK1CqelgBZ7" data-callback="javascriptCallback"></div>
      <input type="submit"  class="btn btn-primary btn-block btn-lg tx-bold" name="download_a" value="CONTINUE">
      </form>`;

    it('recognises short links', () => {
      expect(plugin.matches.some((re) => re.test('https://send.now/d/1pLfI'))).toBe(true);
    });

    it('turns a short link into the file id, has the user solve Turnstile and continues', async () => {
      const posts: HttpRequest[] = [];
      const ctx = fakeCtx({
        'GET https://send.now/d/1pLfI': { body: CHALLENGE },
        'GET https://send.now/abcdefghijkl': { body: CHALLENGE },
        'POST https://send.now/abcdefghijkl': (req) => {
          posts.push(req);
          if (req.form?.op === 'download1') return { body: PAGE2() };
          return { status: 302, headers: { location: CDN } };
        },
      });
      ctx.captchaToken = 'TURNSTILE-TOKEN';
      expect((await plugin.resolve('https://send.now/d/1pLfI', ctx)).url).toBe(CDN);
      expect(ctx.captchas).toEqual([{ kind: 'turnstile', siteKey: '0x4AAAAAABrUKnK1CqelgBZ7', pageUrl: 'https://send.now/abcdefghijkl' }]);
      // JD handleCaptcha: the token goes as cf-turnstile-response and g-recaptcha-response,
      // with the button the browser would send.
      expect(posts[0].form).toMatchObject({
        op: 'download1',
        id: 'abcdefghijkl',
        download_a: 'CONTINUE',
        'cf-turnstile-response': 'TURNSTILE-TOKEN',
        'g-recaptcha-response': 'TURNSTILE-TOKEN',
      });
      expect(posts[0].form).not.toHaveProperty('turnstile_callback');
    });

    it('takes the id from the URL the short link ends on', async () => {
      const ctx = fakeCtx({ 'GET https://send.now/d/1pLfI': { url: 'https://send.now/abcdefghijkl', body: PAGE1 }, 'GET https://send.now/abcdefghijkl': { body: PAGE1 } });
      expect(await plugin.check!('https://send.now/d/1pLfI', ctx)).toMatchObject({ online: true, name: 'Film.part1.rar' });
    });
  });
});
