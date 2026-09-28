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
  expect(req.form).toMatchObject({ op: 'download2', id: 'abcdefghijkl', rand: 'xyz', method_premium: '1' });
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
    expect(plugin.account?.secretLabel).toBe('Passwort oder xfss-Cookie');
    expect(plugin.account?.help).toContain('xfss');
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
    expect(r.maxConnections).toBe(4);
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

  it('flags a free account', async () => {
    const ctx = fakeCtx(
      { 'GET https://ddownload.com/?op=my_account': { body: '<a href="/?op=logout">Logout</a> Free account' } },
      { id: 1, user: 'bob', secret: 'pw' },
    );
    expect(await plugin.checkAccount!(ctx)).toMatchObject({ valid: true, premium: false });
  });

  it('needs an account', async () => {
    await expect(plugin.resolve(LINK, fakeCtx({}))).rejects.toMatchObject({ haulKind: 'account' });
  });
});
