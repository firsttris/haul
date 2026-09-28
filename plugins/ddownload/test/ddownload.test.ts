import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import plugin from '../src/index';

const LINK = 'https://ddownload.com/abcdefghijkl/Some.File.part1.rar';
const FILE_PAGE = `<html><div class="name position-relative"><h4>Some.File.part1.rar</h4></div>
  <span class="file-size">1,2 GB</span>
  <form name="F1" method="POST" action="">
    <input type="hidden" name="op" value="download2">
    <input type="hidden" name="id" value="abcdefghijkl">
    <input type="hidden" name="rand" value="xyz">
    <input type="hidden" name="method_free" value="">
  </form></html>`;
const ACCOUNT_PAGE = `<a href="/?op=logout">Logout</a>
  <div>Premium Account expire: <b>2099-01-31 12:00:00</b></div>
  <div>Traffic available: <b>187 GB</b></div>`;

describe('ddownload', () => {
  it('matches both domains', () => {
    const re = plugin.matches[0];
    expect(re.test(LINK)).toBe(true);
    expect(re.test('https://ddl.to/abcdefghijkl')).toBe(true);
    expect(re.test('https://example.com/abcdefghijkl')).toBe(false);
  });

  it('checks a file page', async () => {
    const ctx = fakeCtx({ 'GET https://ddownload.com/abcdefghijkl': { body: FILE_PAGE } });
    const r = await plugin.check!(LINK, ctx);
    expect(r).toEqual({ online: true, name: 'Some.File.part1.rar', size: Math.round(1.2 * 1024 ** 3) });
  });

  it('detects offline files', async () => {
    const ctx = fakeCtx({ 'GET https://ddownload.com/abcdefghijkl': { body: '<b>File Not Found</b>' } });
    expect((await plugin.check!(LINK, ctx)).online).toBe(false);
  });

  it('resolves via web login and premium form', async () => {
    let loggedIn = false;
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': () => (loggedIn ? { body: ACCOUNT_PAGE } : { status: 302, headers: { location: '/login.html' } }),
        'GET https://ddownload.com/login.html': {
          body: '<form method="POST" action="/"><input name="op" value="login"><input name="login"><input type="password" name="password"></form>',
        },
        'POST https://ddownload.com/': (req) => {
          loggedIn = req.form?.login === 'bob' && req.form?.password === 'pw';
          return { status: 302, headers: { location: '/?op=my_account' } };
        },
        'GET https://ddownload.com/abcdefghijkl': { body: FILE_PAGE },
        'POST https://ddownload.com/abcdefghijkl': (req) => {
          expect(req.form).toMatchObject({ op: 'download2', id: 'abcdefghijkl', rand: 'xyz', method_premium: '1' });
          expect(req.form).not.toHaveProperty('method_free');
          return { status: 302, headers: { location: 'https://srv12.ddownload.com/d/HASH/Some.File.part1.rar' } };
        },
      },
      { id: 1, user: 'bob', secret: 'pw' },
    );
    const r = await plugin.resolve(LINK, ctx);
    expect(r.url).toBe('https://srv12.ddownload.com/d/HASH/Some.File.part1.rar');
    expect(r.maxConnections).toBe(4);
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

  it('rejects a wrong password', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': { status: 302, headers: { location: '/login.html' } },
        'GET https://ddownload.com/login.html': { body: '<form><input name="op" value="login"></form>' },
        'POST https://ddownload.com/': { body: 'Incorrect Login or Password' },
      },
      { id: 1, user: 'bob', secret: 'wrong' },
    );
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'account' });
  });

  it('refuses a captcha login and asks for an API key', async () => {
    const ctx = fakeCtx(
      {
        'GET https://ddownload.com/?op=my_account': { status: 302, headers: { location: '/login.html' } },
        'GET https://ddownload.com/login.html': {
          body: '<form><input name="op" value="login"><div class="g-recaptcha"></div></form>',
        },
      },
      { id: 1, user: 'bob', secret: 'pw' },
    );
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'account', message: expect.stringContaining('API-Key') });
  });

  it('reads account info from the web page', async () => {
    const ctx = fakeCtx(
      { 'GET https://ddownload.com/?op=my_account': { body: ACCOUNT_PAGE } },
      { id: 1, user: 'bob', secret: 'pw' },
    );
    const info = await plugin.checkAccount!(ctx);
    expect(info).toMatchObject({ valid: true, premium: true, trafficLeft: 187 * 1024 ** 3 });
    expect(info.validUntil).toBe(Date.UTC(2099, 0, 31));
  });

  it('uses the API with an API key', async () => {
    const ctx = fakeCtx(
      {
        'GET https://api-v2.ddownload.com/api/file/direct_link?key=K&file_code=abcdefghijkl': {
          body: JSON.stringify({ status: 200, result: { url: 'https://srv3.ddownload.com/d/API/f.rar', size: 42 } }),
        },
        'GET https://api-v2.ddownload.com/api/account/info?key=K': {
          body: JSON.stringify({ status: 200, result: { premium_expire: '2099-05-01 00:00:00', traffic_left: 1024 } }),
        },
        'GET https://api-v2.ddownload.com/api/file/info?key=K': {
          body: JSON.stringify({ status: 200, result: [{ status: 404, file_code: 'abcdefghijkl' }] }),
        },
      },
      { id: 2, user: '', secret: 'K' },
    );
    expect(await plugin.resolve(LINK, ctx)).toMatchObject({ url: 'https://srv3.ddownload.com/d/API/f.rar', size: 42 });
    expect(await plugin.checkAccount!(ctx)).toMatchObject({ valid: true, premium: true, trafficLeft: 1024 ** 3 });
    expect((await plugin.check!(LINK, ctx)).online).toBe(false);
  });

  it('needs an account', async () => {
    await expect(plugin.resolve(LINK, fakeCtx({}))).rejects.toMatchObject({ haulKind: 'account' });
  });
});
