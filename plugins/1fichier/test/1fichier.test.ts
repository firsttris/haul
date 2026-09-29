import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import type { HttpRequest } from '@haul/plugin-sdk';
import plugin, { checkErrors, downloadLink, fileUrl } from '../src/index';

const LINK = 'https://1fichier.com/?abc123def456';
// Free page as JD/pyLoad parse it: the form without password.
const PAGE = `<form method="post" action="https://1fichier.com/?abc123def456">
  <input type="hidden" name="adz" value="1.2">
  <input type="checkbox" name="dl_no_ssl" value="on">
  <input type="submit" name="save" value="Download">
</form>`;
const AFTER = `<div style="text-align:center"><a href="https://a-12.1fichier.com/c987654321" style="float:none;" class="ok btn-general btn-orange">Click here to download the file</a></div>`;
const res = (body: string, status = 200) =>
  ({ status, url: LINK, headers: {}, body, file: false, ok: () => status < 300, text: () => body, json: () => JSON.parse(body), header: () => null }) as never;

describe('1fichier links', () => {
  it('keeps the domain and rewrites old subdomain links', () => {
    expect(fileUrl('https://www.1fichier.com/?AbC123def456&af=1')).toBe('https://1fichier.com/?abc123def456');
    expect(fileUrl('https://alterupload.com/?xyz789ab')).toBe('https://alterupload.com/?xyz789ab');
    expect(fileUrl('https://abc123def.1fichier.com/')).toBe('https://1fichier.com/?abc123def');
    expect(fileUrl('https://1fichier.com/dir/AbCd')).toBeNull();
    const m = (l: string) => plugin.matches.some((re) => re.test(l));
    expect(m('https://1fichier.com/dir/AbCd123')).toBe(true);
    expect(m('https://1fichier.com/en/dir/AbCd123')).toBe(true);
    expect(m('https://a-12.1fichier.com/c987654321')).toBe(false);
  });
});

describe('1fichier check and crawl', () => {
  const check = (answer: string) => ({
    'POST https://1fichier.com/check_links.pl': (req: HttpRequest) => {
      expect(req.body).toBe(`links[]=${encodeURIComponent(LINK)}`);
      return { body: answer };
    },
  });

  it('reads name and size from check_links.pl', async () => {
    const ctx = fakeCtx(check(`${LINK};Film.part1.rar;1073741824\n`));
    expect(await plugin.check!(LINK, ctx)).toEqual({ online: true, name: 'Film.part1.rar', size: 1073741824 });
    expect(await plugin.crawl!(LINK, ctx)).toEqual({ files: [{ url: LINK, name: 'Film.part1.rar', size: 1073741824 }] });
  });

  it('knows NOT FOUND, BAD LINK and PRIVATE', async () => {
    expect((await plugin.check!(LINK, fakeCtx(check(`${LINK};;;NOT FOUND`)))).online).toBe(false);
    expect((await plugin.check!(LINK, fakeCtx(check(`${LINK};;;BAD LINK`)))).online).toBe(false);
    expect(await plugin.check!(LINK, fakeCtx(check(`${LINK};;;PRIVATE`)))).toEqual({ online: true, name: undefined, size: undefined });
    await expect(plugin.crawl!(LINK, fakeCtx(check(`${LINK};;;NOT FOUND`)))).rejects.toMatchObject({ haulKind: 'offline' });
  });

  it('crawls a shared folder via ?json=1 and names it', async () => {
    const ctx = fakeCtx({
      'GET https://1fichier.com/dir/AbCd123?json=1': {
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify([
          { filename: 'a.part1.rar', size: 100, link: 'https://1fichier.com/?aaaaa11111', password: 0, acl: 0 },
          { filename: 'a.part2.rar', size: 50, link: 'https://1fichier.com/?bbbbb22222', password: 0, acl: 0 },
        ]),
      },
      'GET https://1fichier.com/dir/AbCd123?lg=en': { body: '<div class="bloc2">Shared folder My Film</div>' },
    });
    expect(await plugin.crawl!('https://1fichier.com/dir/AbCd123', ctx)).toEqual({
      packageName: 'My Film',
      files: [
        { url: 'https://1fichier.com/?aaaaa11111', name: 'a.part1.rar', size: 100 },
        { url: 'https://1fichier.com/?bbbbb22222', name: 'a.part2.rar', size: 50 },
      ],
    });
  });
});

describe('1fichier download', () => {
  it('posts the form with did=1 and without save, then takes the link', async () => {
    const ctx = fakeCtx({
      'GET https://1fichier.com/?abc123def456&lg=en': (req) => {
        expect(req.headers?.['Accept-Language']).toBe('en-us,en;q=0.5');
        return { body: PAGE };
      },
      'POST https://1fichier.com/?abc123def456': (req) => {
        expect(req.form).toEqual({ adz: '1.2', did: '1' });
        return { body: AFTER };
      },
    });
    const r = await plugin.resolve(LINK, ctx);
    expect(r).toMatchObject({ url: 'https://a-12.1fichier.com/c987654321', maxConnections: 1 });
    expect(ctx.jar.get('LG')).toBe('en');
  });

  it('downloads hotlinks directly with more connections', async () => {
    const ctx = fakeCtx({ 'GET https://1fichier.com/?abc123def456&lg=en': { file: true } });
    expect((await plugin.resolve(LINK, ctx)).maxConnections).toBe(3);
  });

  it('waits out a short countdown and loads the page again (pyLoad)', async () => {
    let loads = 0;
    const ctx = fakeCtx({
      'GET https://1fichier.com/?abc123def456&lg=en': () => ({ body: ++loads === 1 ? '<span>Free download in ⏳ 30</span>' : PAGE }),
      'POST https://1fichier.com/?abc123def456': { body: AFTER },
    });
    expect((await plugin.resolve(LINK, ctx)).url).toContain('a-12.1fichier.com');
    expect(ctx.waits).toContain(31);
  });

  it('reports the waits JD knows, with their time', () => {
    const wait = (html: string, status = 200) => {
      try {
        checkErrors(res(html, status));
      } catch (e) {
        return e as { haulKind: string; haulWait?: number };
      }
      return null;
    };
    expect(wait('<p>You must wait 13 minutes between each downloads</p>')).toMatchObject({ haulWait: 780 });
    expect(wait('<p>all good</p>')).toBeNull();
    expect(wait('you must wait at least 13 minutes between each downloads')).toMatchObject({ haulWait: 780 });
    expect(wait('<div> You must wait 7 minutes</div>')).toMatchObject({ haulWait: 420, haulScope: 'hoster' });
    // A server error is about this file only (JD: ERROR_TEMPORARILY_UNAVAILABLE).
    const software = wait('<p> Software error:</p>');
    expect(software).toMatchObject({ haulKind: 'temporary', haulWait: 600 });
    expect(software).not.toHaveProperty('haulScope');
    expect(wait('Warning ! Without subscription, you can only download one file at a time...')).toMatchObject({ haulWait: 300 });
    expect(wait('<b> IP Locked</b>')).toMatchObject({ haulWait: 3600 });
    expect(wait('<p> Free download is temporarily limited due to high demand</p>')).toMatchObject({ haulWait: 900 });
    expect(wait('The free offer is intended to … You already downloaded for free more than 20 GB')).toMatchObject({ haulWait: 3600 });
    expect(wait('<p> File not found !</p>')).toMatchObject({ haulKind: 'offline' });
    expect(wait('professional infrastructure detected')).toMatchObject({ haulKind: 'fatal' });
    expect(wait('<p> Access to this file is protected</p>')).toMatchObject({ haulKind: 'fatal' });
    expect(wait('nothing', 403)).toMatchObject({ haulWait: 900 });
  });

  it('finds the download link in both layouts', () => {
    expect(downloadLink(AFTER)).toBe('https://a-12.1fichier.com/c987654321');
    expect(downloadLink(`<a href="https://a-3.1fichier.com/c1" class="x">Start your download</a>`)).toBe('https://a-3.1fichier.com/c1');
    expect(downloadLink('nothing')).toBeUndefined();
  });

  it('refuses password-protected files for now', async () => {
    const ctx = fakeCtx({
      'GET https://1fichier.com/?abc123def456&lg=en': { body: '<form method="post" action=""><input type="password" name="pass"></form>' },
    });
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'fatal' });
  });
});
