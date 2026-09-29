import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import type { HttpRequest } from '@haul/plugin-sdk';
import plugin, { findDownloadLink, parseLink } from '../src/index';

const API = 'https://www.mediafire.com/api/1.5';
const ok = (response: object) => ({ body: JSON.stringify({ response: { result: 'Success', current_api_version: '1.5', ...response } }) });
const INFO = {
  quickkey: 'q1w2e3r4t5y6u7i',
  filename: 'Film.part1.rar',
  size: '104857600',
  privacy: 'public',
  password_protected: 'no',
};
const DL = 'https://download2393.mediafire.com/abcDEF123/q1w2e3r4t5y6u7i/Film.part1.rar';
// Current page: the link base64-encoded on the button (as parsed by mediafire_bulk_downloader).
const PAGE = `<div class="download_link"><a class="input popsok" aria-label="Download file" href="https://www.mediafire.com/download_repair.php?x" id="downloadButton" data-scrambled-url="${Buffer.from(DL).toString('base64')}" rel="nofollow">Download (100MB)</a></div>`;
const LINK = 'https://www.mediafire.com/file/q1w2e3r4t5y6u7i/Film.part1.rar/file';

describe('mediafire links', () => {
  it('recognises the URL forms JD supports', () => {
    expect(parseLink(LINK)).toEqual({ kind: 'file', id: 'q1w2e3r4t5y6u7i' });
    expect(parseLink('https://mediafire.com/download/q1w2e3r4t5y6u7i')).toEqual({ kind: 'file', id: 'q1w2e3r4t5y6u7i' });
    expect(parseLink('https://www.mediafire.com/view/?q1w2e3')).toBeUndefined();
    expect(parseLink('https://www.mediafire.com/download.php?q1w2e3')).toEqual({ kind: 'file', id: 'q1w2e3' });
    expect(parseLink('https://www.mediafire.com/?q1w2e3r4t5y6u7i')).toEqual({ kind: 'file', id: 'q1w2e3r4t5y6u7i' });
    expect(parseLink('https://www.mediafire.com/?abcdefghijklm')).toEqual({ kind: 'folder', key: 'abcdefghijklm' });
    expect(parseLink('https://www.mediafire.com/?abcdefghijklm,q1w2e3')).toEqual({ kind: 'ids', ids: ['abcdefghijklm', 'q1w2e3'] });
    expect(parseLink('https://app.mediafire.com/folder/abcdefghijklm/My+Stuff')).toEqual({ kind: 'folder', key: 'abcdefghijklm' });
    expect(parseLink('https://www.mediafire.com/folder/abcdefghijklm/shared')).toEqual({ kind: 'folder', key: 'abcdefghijklm' });
    expect(parseLink(DL)).toEqual({ kind: 'file', id: 'q1w2e3r4t5y6u7i', direct: DL });
    expect(plugin.matches.some((re) => re.test('https://mfi.re/file/abc'))).toBe(true);
    expect(plugin.matches.some((re) => re.test(DL))).toBe(true);
    expect(plugin.matches.some((re) => re.test('https://example.com/file/abc'))).toBe(false);
  });

  it('finds the download link in current and older page layouts', () => {
    expect(findDownloadLink(PAGE)).toBe(DL);
    expect(findDownloadLink(`<a class="input" href="${DL}" id="downloadButton">`)).toBe(DL);
    expect(findDownloadLink(`<a aria-label="Download file"\n href="${DL}">`)).toBe(DL);
    expect(findDownloadLink(`<script>var kNO = "${DL}";</script>`)).toBe(DL);
    expect(findDownloadLink(`<p>${DL}</p>`)).toBe(DL);
    expect(findDownloadLink('<html>nothing</html>')).toBeUndefined();
  });
});

describe('mediafire crawl and check', () => {
  it('names a single file through the API', async () => {
    const ctx = fakeCtx({ [`GET ${API}/file/get_info.php?quick_key=q1w2e3r4t5y6u7i&response_format=json`]: ok({ file_info: INFO }) });
    expect(await plugin.crawl!(LINK, ctx)).toEqual({ files: [{ url: LINK, name: 'Film.part1.rar', size: 104857600 }] });
    expect(await plugin.check!(LINK, ctx)).toEqual({ online: true, name: 'Film.part1.rar', size: 104857600 });
  });

  it('reports deleted and unknown files as offline', async () => {
    const deleted = fakeCtx({ [`GET ${API}/file/get_info.php`]: ok({ file_info: { ...INFO, delete_date: '2026-01-02 10:00:00' } }) });
    await expect(plugin.crawl!(LINK, deleted)).rejects.toMatchObject({ haulKind: 'offline' });
    const unknown = fakeCtx({
      [`GET ${API}/file/get_info.php`]: {
        status: 403,
        body: JSON.stringify({ response: { action: 'file/get_info', message: 'Unknown or Invalid QuickKey', error: 110, result: 'Error' } }),
      },
    });
    expect((await plugin.check!(LINK, unknown)).online).toBe(false);
    await expect(plugin.resolve(LINK, unknown)).rejects.toMatchObject({ haulKind: 'offline' });
  });

  it('crawls a folder with paging and subfolders', async () => {
    const content = (req: HttpRequest) => {
      const q = new URL(req.url).searchParams;
      const key = q.get('folder_key');
      const type = q.get('content_type');
      const chunk = q.get('chunk');
      if (key === 'abcdefghijklm' && type === 'files' && chunk === '1')
        return ok({ folder_content: { files: [INFO], more_chunks: 'yes' } });
      if (key === 'abcdefghijklm' && type === 'files' && chunk === '2')
        return ok({
          folder_content: {
            files: [
              { ...INFO, quickkey: 'zzz2', filename: 'Film.part2.rar', size: '10' },
              { ...INFO, quickkey: 'gone1', filename: 'old.txt', delete_date: '2025-05-05 00:00:00' },
            ],
            more_chunks: 'no',
          },
        });
      if (key === 'abcdefghijklm' && type === 'folders')
        return ok({ folder_content: { folders: [{ folderkey: 'subfolder1234', name: 'Extras' }], more_chunks: 'no' } });
      if (key === 'subfolder1234' && type === 'files')
        return ok({ folder_content: { files: [{ ...INFO, quickkey: 'nfo1', filename: 'Film Info.nfo', size: 5 }], more_chunks: 'no' } });
      return ok({ folder_content: { more_chunks: 'no' } });
    };
    const ctx = fakeCtx({
      [`GET ${API}/folder/get_info.php?folder_key=abcdefghijklm`]: ok({ folder_info: { name: 'My Film', file_count: '3', folder_count: '1' } }),
      [`GET ${API}/folder/get_info.php?folder_key=subfolder1234`]: ok({ folder_info: { name: 'Extras' } }),
      [`GET ${API}/folder/get_content.php`]: content,
    });
    const r = await plugin.crawl!('https://www.mediafire.com/folder/abcdefghijklm/My+Film', ctx);
    expect(r.packageName).toBe('My Film');
    expect(r.files).toEqual([
      { url: LINK, name: 'Film.part1.rar', size: 104857600 },
      { url: 'https://www.mediafire.com/file/zzz2/Film.part2.rar/file', name: 'Film.part2.rar', size: 10 },
      { url: 'https://www.mediafire.com/file/nfo1/Film%20Info.nfo/file', name: 'Film Info.nfo', size: 5 },
    ]);
  });

  it('treats an unknown folder as offline', async () => {
    const ctx = fakeCtx({
      [`GET ${API}/folder/get_info.php`]: { status: 403, body: JSON.stringify({ response: { message: 'Session Token is missing', error: 104, result: 'Error' } }) },
    });
    await expect(plugin.crawl!('https://www.mediafire.com/folder/abcdefghijklm', ctx)).rejects.toMatchObject({ haulKind: 'offline' });
  });
});

describe('mediafire resolve', () => {
  const info = { [`GET ${API}/file/get_info.php`]: ok({ file_info: INFO }) };

  it('takes the scrambled link from the file page', async () => {
    const ctx = fakeCtx({ ...info, 'GET https://www.mediafire.com/file/q1w2e3r4t5y6u7i': { body: PAGE } });
    const r = await plugin.resolve(LINK, ctx);
    expect(r).toMatchObject({ url: DL, name: 'Film.part1.rar', size: 104857600, maxConnections: 15 });
    expect(r.headers?.['User-Agent']).toMatch(/Mozilla/);
  });

  it('ticks the checkbox captcha', async () => {
    const captcha = `<form name="form_captcha" method="post" action="/file/q1w2e3r4t5y6u7i">
      <input type="hidden" name="security" value="sec1"><input type="checkbox" id="customCaptchaCheckbox">
      <label for="customCaptchaCheckbox">I'm not a robot</label></form>`;
    const ctx = fakeCtx({
      ...info,
      'GET https://www.mediafire.com/file/q1w2e3r4t5y6u7i': { body: captcha },
      'POST https://www.mediafire.com/file/q1w2e3r4t5y6u7i': (req) => {
        expect(req.form).toEqual({ security: 'sec1', mf_captcha_response: '1' });
        return { body: PAGE };
      },
    });
    expect((await plugin.resolve(LINK, ctx)).url).toBe(DL);
  });

  it('gives up on a reCaptcha for now', async () => {
    const ctx = fakeCtx({
      ...info,
      'GET https://www.mediafire.com/file/q1w2e3r4t5y6u7i': { body: '<form name="form_captcha"><div class="g-recaptcha" data-sitekey="x"></div></form>' },
    });
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'temporary' });
  });

  it('switches the User-Agent at the IP limit', async () => {
    const seen: string[] = [];
    const ctx = fakeCtx({
      ...info,
      'GET https://www.mediafire.com/file/q1w2e3r4t5y6u7i': (req) => {
        seen.push(req.headers!['User-Agent']);
        return { body: seen.length < 3 ? '<script>var limitReachedTTL = 600;</script>' : PAGE };
      },
    });
    const r = await plugin.resolve(LINK, ctx);
    expect(new Set(seen).size).toBe(3);
    // The download uses the User-Agent that got through.
    expect(r.headers?.['User-Agent']).toBe(seen[2]);
  });

  it('reports the IP limit when every User-Agent is blocked', async () => {
    const ctx = fakeCtx({ ...info, 'GET https://www.mediafire.com/file/q1w2e3r4t5y6u7i': { body: 'var limitReachedTTL = 600;' } });
    await expect(plugin.resolve(LINK, ctx)).rejects.toThrow(/Limit dieser IP/);
  });

  it('maps errno pages and temporary pages', async () => {
    const page = (route: object) => fakeCtx({ ...info, 'GET https://www.mediafire.com/file/q1w2e3r4t5y6u7i': route });
    await expect(plugin.resolve(LINK, page({ url: 'https://www.mediafire.com/error.php?errno=320', body: '<html>' }))).rejects.toMatchObject({
      haulKind: 'offline',
    });
    await expect(plugin.resolve(LINK, page({ url: 'https://www.mediafire.com/error.php?errno=999', body: '<html>' }))).rejects.toThrow(/privat/);
    await expect(plugin.resolve(LINK, page({ url: 'https://www.mediafire.com/download_repair.php?flag=9', body: '<html>' }))).rejects.toMatchObject({
      haulKind: 'temporary',
    });
    await expect(plugin.resolve(LINK, page({ body: '<p class="error-title">Temporarily Unavailable</p>' }))).rejects.toMatchObject({
      haulKind: 'temporary',
    });
    await expect(plugin.resolve(LINK, page({ body: '<html>nothing</html>' }))).rejects.toThrow(/Download-Link nicht gefunden/);
  });

  it('refuses private, password and malware files', async () => {
    const priv = fakeCtx({ [`GET ${API}/file/get_info.php`]: ok({ file_info: { ...INFO, privacy: 'private' } }) });
    await expect(plugin.resolve(LINK, priv)).rejects.toThrow(/private Datei/);
    const pw = fakeCtx({ ...info, 'GET https://www.mediafire.com/file/q1w2e3r4t5y6u7i': { body: '<div class="passwordPrompt">' } });
    await expect(plugin.resolve(LINK, pw)).rejects.toThrow(/passwortgeschützt/);
    const mal = fakeCtx({ ...info, 'GET https://www.mediafire.com/file/q1w2e3r4t5y6u7i': { body: '<div class="MalwareAdvisory">' } });
    await expect(plugin.resolve(LINK, mal)).rejects.toThrow(/Schadsoftware/);
  });

  it('uses a working direct link without loading the page', async () => {
    const ctx = fakeCtx({ [`HEAD ${DL}`]: { file: true } });
    expect((await plugin.resolve(DL, ctx)).url).toBe(DL);
    expect(ctx.requests).toHaveLength(1);
  });

  it('downloads a hotlinked file page directly', async () => {
    const ctx = fakeCtx({ ...info, 'GET https://www.mediafire.com/file/q1w2e3r4t5y6u7i': { file: true } });
    expect((await plugin.resolve(LINK, ctx)).url).toBe('https://www.mediafire.com/file/q1w2e3r4t5y6u7i');
  });
});
