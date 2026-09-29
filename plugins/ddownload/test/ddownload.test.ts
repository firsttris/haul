import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import type { HttpRequest } from '@haul/plugin-sdk';
import plugin from '../src/index';

const LINK = 'https://ddownload.com/abcdefghijkl/Some.File.part1.rar';
// Markup as matched by pyLoad's DdownloadCom plugins.
const FILE_PAGE = `<html><div class="name position-relative"><h1 class="file-info-name">Some.File.part1.rar</h1></div>
  <span class="file-size">1,2 GB</span>
  <form name="F1" method="POST" action="">
    <input type="hidden" name="op" value="download2">
    <input type="hidden" name="id" value="abcdefghijkl">
    <input type="hidden" name="rand" value="xyz">
    <input type="hidden" name="method_free" value="">
  </form></html>`;
const ACCOUNT_PAGE = `<a href="/?op=logout">Logout</a>
  <span class="badge ma-ultimate-pill">Ultimate</span>
  <div>Active until 31 January 2099</div>
  <div>Traffic: <span id="trafficValue">187000</span> MB</div>`;
const LOGIN_PAGE = `<form name="FL" method="POST" action="/">
  <input type="hidden" name="op" value="login"><input type="hidden" name="token" value="t0k">
  <input name="login"><input type="password" name="password">
  <div class="cf-turnstile" data-sitekey="0x4AAA"></div>
</form>`;
const LOGGED_OUT = { status: 302, headers: { location: '/login.html' } };
const FILE_POST = (req: HttpRequest) => {
  expect(req.form).toMatchObject({
    op: 'download2',
    id: 'abcdefghijkl',
    rand: 'xyz',
    method_premium: 'Premium Download',
    referer: 'https://ddownload.com/abcdefghijkl',
  });
  expect(req.form).not.toHaveProperty('method_free');
  return { status: 302, headers: { location: 'https://srv12.ddownload.com/d/HASH/Some.File.part1.rar' } };
};

describe('ddownload', () => {
  it('matches both domains', () => {
    const re = plugin.matches[0];
    expect(re.test(LINK)).toBe(true);
    expect(re.test('https://ddl.to/abcdefghijkl')).toBe(true);
    expect(re.test('https://example.com/abcdefghijkl')).toBe(false);
  });

  it('describes its account form', () => {
    expect(plugin.account?.secretLabel).toEqual({ de: 'Passwort oder xfss-Cookie', en: 'Password or xfss cookie' });
    const help = plugin.account?.help as { de: string; en: string };
    expect(help.de).toContain('xfss');
    expect(help.en).toContain('xfss');
  });

  it('checks a file page', async () => {
    const ctx = fakeCtx({ 'GET https://ddownload.com/abcdefghijkl': { body: FILE_PAGE } });
    const r = await plugin.check!(LINK, ctx);
    expect(r).toEqual({ online: true, name: 'Some.File.part1.rar', size: Math.round(1.2 * 1024 ** 3) });
  });

  it('detects offline files', async () => {
    for (const body of ['<b>File Not Found</b>', '<h2>File Deleted</h2>']) {
      const ctx = fakeCtx({ 'GET https://ddownload.com/abcdefghijkl': { body } });
      expect((await plugin.check!(LINK, ctx)).online).toBe(false);
    }
  });

  it('logs in with user and password when the site lets it', async () => {
    let loggedIn = false;
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': () => (loggedIn ? { body: ACCOUNT_PAGE } : LOGGED_OUT),
        'GET https://ddownload.com/login.html': { body: LOGIN_PAGE },
        'POST https://ddownload.com/': (req) => {
          expect(req.form).toMatchObject({ op: 'login', token: 't0k', login: 'bob', password: 'pw' });
          loggedIn = true;
          return { status: 302, headers: { location: '/?op=my_account' } };
        },
        'GET https://ddownload.com/abcdefghijkl': { body: FILE_PAGE },
        'POST https://ddownload.com/abcdefghijkl': FILE_POST,
      },
      { id: 1, user: 'bob', secret: 'pw' },
    );
    const r = await plugin.resolve(LINK, ctx);
    expect(r.url).toBe('https://srv12.ddownload.com/d/HASH/Some.File.part1.rar');
    expect(r.maxConnections).toBe(1);
    expect(r.headers).toEqual({ Referer: 'https://ddownload.com/abcdefghijkl' });
  });

  it('explains the cookie login when the captcha blocks the password login', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': LOGGED_OUT,
        'GET https://ddownload.com/login.html': { body: LOGIN_PAGE },
        'POST https://ddownload.com/': { body: LOGIN_PAGE + '<div class="alert">Wrong captcha</div>' },
      },
      { id: 1, user: 'bob', secret: 'pw' },
    );
    const err = await plugin.checkAccount!(ctx).catch((e) => e);
    expect(err.haulKind).toBe('account');
    expect(err.message).toContain('Captcha');
    expect(err.message).toContain('xfss=');
    expect(err.message).not.toContain('API');
  });

  it('reports a wrong password as such', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': LOGGED_OUT,
        'GET https://ddownload.com/login.html': { body: LOGIN_PAGE },
        'POST https://ddownload.com/': { body: 'Incorrect Login or Password' },
        'GET https://ddownload.com/abcdefghijkl': { body: FILE_PAGE },
      },
      { id: 1, user: 'bob', secret: 'wrong' },
    );
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'account', message: expect.stringContaining('falsch') });
  });

  it('uses a session cookie from the browser', async () => {
    const withCookie = (req: HttpRequest) => {
      expect(req.headers?.Cookie).toBe('xfss=SESSION; lang=english');
    };
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': (req) => (withCookie(req), { body: ACCOUNT_PAGE }),
        'GET https://ddownload.com/abcdefghijkl': (req) => (withCookie(req), { body: FILE_PAGE }),
        'POST https://ddownload.com/abcdefghijkl': (req) => (withCookie(req), FILE_POST(req)),
      },
      { id: 1, user: 'bob', secret: '  xfss=SESSION ' },
    );
    expect((await plugin.resolve(LINK, ctx)).url).toBe('https://srv12.ddownload.com/d/HASH/Some.File.part1.rar');
    expect(ctx.requests.some((r) => r.url.includes('login.html'))).toBe(false);
  });

  it('accepts the bare cookie value with an empty user', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': (req) => {
          expect(req.headers?.Cookie).toBe('xfss=SESSION; lang=english');
          return { body: ACCOUNT_PAGE };
        },
      },
      { id: 1, user: '', secret: 'SESSION' },
    );
    expect((await plugin.checkAccount!(ctx)).valid).toBe(true);
  });

  it('reports an expired cookie', async () => {
    const ctx = fakeCtx({ 'GET https://ddownload.com/?op=my_account': LOGGED_OUT }, { id: 1, user: 'bob', secret: 'xfss=OLD' });
    await expect(plugin.checkAccount!(ctx)).rejects.toMatchObject({ haulKind: 'account', message: expect.stringContaining('abgelaufen') });
  });

  it('uses the direct redirect when enabled in the account', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': { body: ACCOUNT_PAGE },
        'GET https://ddownload.com/abcdefghijkl': { status: 302, headers: { location: 'https://srv1.ddownload.com/d/X/f.rar' } },
      },
      { id: 1, user: 'bob', secret: 'pw' },
    );
    expect((await plugin.resolve(LINK, ctx)).url).toBe('https://srv1.ddownload.com/d/X/f.rar');
  });

  it('reads Ultimate status, traffic and expiry from the dashboard', async () => {
    const ctx = fakeCtx({ 'GET https://ddownload.com/?op=my_account': { body: ACCOUNT_PAGE } }, { id: 1, user: 'bob', secret: 'pw' });
    const info = await plugin.checkAccount!(ctx);
    expect(info).toMatchObject({ valid: true, premium: true, validUntil: Date.UTC(2099, 0, 31) });
    expect(info.trafficLeft).toBe(Math.round(187 * 1024 ** 3));
  });

  it('reads the 2026 layout (JD r53187)', async () => {
    const page = `<div class="dk-dl-name">Film.2026.mkv</div><span class="dk-dl-size">4,7 GB</span>`;
    const ctx = fakeCtx({ 'GET https://ddownload.com/abcdefghijkl': { body: page } });
    expect(await plugin.check!(LINK, ctx)).toEqual({ online: true, name: 'Film.2026.mkv', size: Math.round(4.7 * 1024 ** 3) });

    const dash = `<a href="/?op=logout">Logout</a><div class="traffic-bar" data-traffic="78700"></div>
      <div>Active until 18 August 2027</div>`;
    const acc = fakeCtx({ 'GET https://ddownload.com/?op=my_account': { body: dash } }, { id: 1, user: 'bob', secret: 'pw' });
    // No Ultimate badge in the new layout: the expiry date decides.
    expect(await plugin.checkAccount!(acc)).toMatchObject({ valid: true, premium: true, trafficLeft: 78_700_000_000 });
  });

  it('follows a redirect to an intermediate page after the form (HTTP 302)', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/abcdefghijkl': { body: `<a href="/account/">Konto</a>${FILE_PAGE}` },
        'POST https://ddownload.com/abcdefghijkl': { status: 302, headers: { location: '/?op=download_link&id=abcdefghijkl' } },
        'GET https://ddownload.com/?op=download_link&id=abcdefghijkl': {
          body: '<a class="dk-btn" href="https://srv7.ddownload.com/d/TOKEN/Some.File.part1.rar">Download</a>',
        },
      },
      { id: 1, user: 'bob', secret: 'xfss=SESSION' },
    );
    expect((await plugin.resolve(LINK, ctx)).url).toBe('https://srv7.ddownload.com/d/TOKEN/Some.File.part1.rar');
    // The account link counts as logged in (JD's isLoggedin), so no extra account check.
    expect(ctx.requests.some((r) => r.url.includes('op=my_account'))).toBe(false);
  });

  it('treats a redirect to the login page as an expired session', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/abcdefghijkl': { status: 302, headers: { location: '/login.html' } },
        'GET https://ddownload.com/?op=my_account': { status: 302, headers: { location: '/login.html' } },
      },
      { id: 1, user: 'bob', secret: 'xfss=OLD' },
    );
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({
      haulKind: 'account',
      message: expect.stringContaining('Kontoseite: HTTP 302'),
    });
  });

  it('names the redirects when nothing is found', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/abcdefghijkl': { body: `<a href="/?op=logout">x</a>${FILE_PAGE}` },
        'POST https://ddownload.com/abcdefghijkl': { status: 302, headers: { location: '/?op=dl_wait' } },
        'GET https://ddownload.com/?op=dl_wait': { body: '<a href="/?op=logout">x</a><p>Bitte warten</p>' },
      },
      { id: 1, user: 'bob', secret: 'xfss=SESSION' },
    );
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('weitergeleitet: /?op=dl_wait'),
    });
  });

  it('keeps a session cookie that the site renews (cookie jar, not a fixed header)', async () => {
    const seen: string[] = [];
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/abcdefghijkl': (req) => {
          seen.push(req.headers!.Cookie);
          return { body: `<a href="/?op=logout">x</a>${FILE_PAGE}`, headers: { 'Set-Cookie': 'xfss=RENEWED; path=/' } };
        },
        'POST https://ddownload.com/abcdefghijkl': (req) => {
          seen.push(req.headers!.Cookie);
          return FILE_POST(req);
        },
      },
      { id: 1, user: 'bob', secret: 'xfss=PASTED' },
    );
    await plugin.resolve(LINK, ctx);
    await plugin.resolve(LINK, ctx);
    expect(seen).toEqual([
      'xfss=PASTED; lang=english',
      'xfss=RENEWED; lang=english',
      'xfss=RENEWED; lang=english',
      'xfss=RENEWED; lang=english',
    ]);
  });

  it('explains a redirect to the payments page (JD: premium-only URL)', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/abcdefghijkl': { body: `<a href="/?op=logout">x</a>${FILE_PAGE}` },
        'POST https://ddownload.com/abcdefghijkl': { status: 302, headers: { location: '/?op=payments' } },
      },
      { id: 1, user: 'bob', secret: 'xfss=SESSION' },
    );
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({
      haulKind: 'account',
      message: expect.stringContaining('Premium-Kaufseite'),
    });
  });

  it('takes a download path on the main domain as the file without loading it', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/abcdefghijkl': { body: `<a href="/?op=logout">x</a>${FILE_PAGE}` },
        'POST https://ddownload.com/abcdefghijkl': { status: 302, headers: { location: '/d/HASH123/Some.File.part1.rar' } },
      },
      { id: 1, user: 'bob', secret: 'xfss=SESSION' },
    );
    expect((await plugin.resolve(LINK, ctx)).url).toBe('https://ddownload.com/d/HASH123/Some.File.part1.rar');
    expect(ctx.requests.some((r) => r.url.includes('/d/HASH123'))).toBe(false);
  });

  it('hands over a response that is the file itself', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/abcdefghijkl': { body: `<a href="/?op=logout">x</a>${FILE_PAGE}` },
        'POST https://ddownload.com/abcdefghijkl': { status: 302, headers: { location: '/?op=get&id=abcdefghijkl' } },
        'GET https://ddownload.com/?op=get&id=abcdefghijkl': { file: true },
      },
      { id: 1, user: 'bob', secret: 'xfss=SESSION' },
    );
    expect((await plugin.resolve(LINK, ctx)).url).toBe('https://ddownload.com/?op=get&id=abcdefghijkl');
  });

  it('falls back to the pasted cookie when the renewed one stopped working', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': (req) =>
          req.headers!.Cookie.includes('xfss=PASTED') ? { body: ACCOUNT_PAGE } : LOGGED_OUT,
      },
      { id: 1, user: 'bob', secret: 'xfss=PASTED' },
    );
    ctx.jar.set('xfss', 'STALE');
    expect((await plugin.checkAccount!(ctx)).valid).toBe(true);
  });

  it('passes on the file name from the page for id-only links (filecrypt)', async () => {
    const idLink = 'https://ddownload.com/ry772kx58yfh';
    const page = `<a href="/?op=logout">x</a>
      <div class="dk-dl-name">Spider-Man.2026.part2.rar</div><span class="dk-dl-size">2,0 GB</span>
      <form name="F1" method="POST" action=""><input type="hidden" name="op" value="download2">
      <input type="hidden" name="id" value="ry772kx58yfh"></form>`;
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/ry772kx58yfh': { body: page },
        'POST https://ddownload.com/ry772kx58yfh': { status: 302, headers: { location: 'https://eu-sirius11.zeuscdn.org:183/x9Tk2' } },
      },
      { id: 1, user: 'bob', secret: 'xfss=SESSION' },
    );
    expect(await plugin.resolve(idLink, ctx)).toMatchObject({
      url: 'https://eu-sirius11.zeuscdn.org:183/x9Tk2',
      name: 'Spider-Man.2026.part2.rar',
      size: 2 * 1024 ** 3,
    });
  });

  it('falls back to the hidden fname field of the download form', async () => {
    const page = `<a href="/?op=logout">x</a><form name="F1" method="POST" action="">
      <input type="hidden" name="op" value="download2"><input type="hidden" name="fname" value="Film.part3.rar"></form>`;
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/abcdefghijkl': { body: page },
        'POST https://ddownload.com/abcdefghijkl': { status: 302, headers: { location: 'https://cdn.zeuscdn.org/abc' } },
      },
      { id: 1, user: 'bob', secret: 'xfss=SESSION' },
    );
    expect((await plugin.resolve(LINK, ctx)).name).toBe('Film.part3.rar');
  });

  it('flags a free account', async () => {
    const ctx = fakeCtx(
      { 'GET https://ddownload.com/?op=my_account': { body: '<a href="/?op=logout">Logout</a> Free account' } },
      { id: 1, user: 'bob', secret: 'pw' },
    );
    expect(await plugin.checkAccount!(ctx)).toMatchObject({ valid: true, premium: false });
  });

  it('walks through several download forms and finds a CDN link in the page', async () => {
    const step1 = FILE_PAGE.replace('value="download2"', 'value="download1"');
    const step2 = `<form name="F1" method="POST" action=""><input type="hidden" name="op" value="download2">
      <input type="hidden" name="id" value="abcdefghijkl"><input type="hidden" name="rand" value="r2"></form>`;
    const ops: string[] = [];
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': { body: ACCOUNT_PAGE },
        'GET https://ddownload.com/abcdefghijkl': { body: step1 },
        'POST https://ddownload.com/abcdefghijkl': (req) => {
          ops.push(req.form!.op);
          return req.form!.op === 'download1'
            ? { body: step2 }
            : { body: `<a class="btn" href="https://dl3.ucdn.to/files/7/ab12cd/Some.File.part1.rar">Download</a>` };
        },
      },
      { id: 1, user: 'bob', secret: 'pw' },
    );
    expect((await plugin.resolve(LINK, ctx)).url).toBe('https://dl3.ucdn.to/files/7/ab12cd/Some.File.part1.rar');
    expect(ops).toEqual(['download1', 'download2']);
  });

  it('names the steps when no link shows up', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': { body: ACCOUNT_PAGE },
        'GET https://ddownload.com/abcdefghijkl': { body: FILE_PAGE },
        'POST https://ddownload.com/abcdefghijkl': { body: '<p>Something unexpected</p>' },
      },
      { id: 1, user: 'bob', secret: 'pw' },
    );
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({
      haulKind: 'temporary',
      message: expect.stringContaining('nach download2'),
    });
  });

  it('treats a commented-out logout link as logged out', async () => {
    const ctx = fakeCtx(
      { 'GET https://ddownload.com/?op=my_account': { body: '<!-- <a href="/?op=logout">Logout</a> --> Login' } },
      { id: 1, user: 'bob', secret: 'xfss=OLD' },
    );
    await expect(plugin.checkAccount!(ctx)).rejects.toMatchObject({ haulKind: 'account' });
  });

  it('reports maintenance as temporary', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': { body: ACCOUNT_PAGE },
        'GET https://ddownload.com/abcdefghijkl': { body: '<strong>Oops!</strong> This server is in maintenance mode.' },
      },
      { id: 1, user: 'bob', secret: 'pw' },
    );
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'temporary', message: expect.stringContaining('Wartung') });
  });

  it('trusts a logged-in file page without checking the account again (like JD)', async () => {
    // Premium file page: logged in, plus the hidden free-user template texts XFS pages carry.
    const page = `<a href="/?op=logout">Logout</a>
      <script>var msg = "You have to wait 45 seconds till next download";</script>
      <!-- <div>You have reached the download-limit</div> -->
      ${FILE_PAGE}`;
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/abcdefghijkl': { body: page },
        'POST https://ddownload.com/abcdefghijkl': FILE_POST,
      },
      { id: 1, user: 'bob', secret: 'xfss=SESSION' },
    );
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => plugin.resolve(LINK, ctx)));
    expect(results.every((r) => r.url.startsWith('https://srv12.ddownload.com/d/'))).toBe(true);
    expect(ctx.requests.some((r) => r.url.includes('op=my_account'))).toBe(false);
  });

  it('quotes a real limit message from the site', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/abcdefghijkl': { body: `<a href="/?op=logout">x</a>${FILE_PAGE}` },
        'POST https://ddownload.com/abcdefghijkl': {
          body: '<a href="/?op=logout">x</a><div class="alert alert-danger">You have reached the download limit: 50 GB</div>',
        },
      },
      { id: 1, user: 'bob', secret: 'xfss=SESSION' },
    );
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({
      haulKind: 'account',
      message: 'ddownload: You have reached the download limit: 50 GB',
    });
  });

  it('quotes the site error box when nothing else fits', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/abcdefghijkl': { body: `<a href="/?op=logout">x</a>${FILE_PAGE}` },
        'POST https://ddownload.com/abcdefghijkl': { body: '<a href="/?op=logout">x</a><b class="err">Wrong IP</b>' },
      },
      { id: 1, user: 'bob', secret: 'xfss=SESSION' },
    );
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({
      haulKind: 'temporary',
      message: expect.stringContaining('Seite: „Wrong IP“'),
    });
  });

  it('needs an account', async () => {
    await expect(plugin.resolve(LINK, fakeCtx({}))).rejects.toMatchObject({ haulKind: 'account' });
  });
});
