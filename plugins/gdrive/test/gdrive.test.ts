import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import type { HttpRequest } from '@haul/plugin-sdk';
import plugin, { confirmUrl, parseLink } from '../src/index';

const ID = '1AbC-dEf_GhIjKlMnOpQrStUvWxYz0123';
const LINK = `https://drive.google.com/file/d/${ID}/view?usp=sharing`;
const QUICK = `POST https://drive.google.com/uc?id=${ID}&authuser=0&export=download`;
const DL = `https://drive.usercontent.google.com/download?id=${ID}&export=download&authuser=0&confirm=t&uuid=u1&at=a1`;
const quick = (data: object) => (req: HttpRequest) => {
  expect(req.headers?.['X-Drive-First-Party']).toBe('DriveViewer');
  expect(req.body).toBe('');
  return { body: `)]}'\n${JSON.stringify(data)}` };
};

describe('google drive links', () => {
  it('knows JD’s link forms, not folders or documents', () => {
    expect(parseLink(LINK)).toEqual({ id: ID, resourceKey: undefined });
    expect(parseLink(`https://drive.google.com/uc?export=download&id=${ID}`)?.id).toBe(ID);
    expect(parseLink(`https://drive.google.com/open?id=${ID}`)?.id).toBe(ID);
    expect(parseLink(`https://drive.usercontent.google.com/download?id=${ID}&export=download`)?.id).toBe(ID);
    expect(parseLink(`https://drive.google.com/file/d/${ID}/view?resourcekey=0-abc`)).toEqual({ id: ID, resourceKey: '0-abc' });
    expect(parseLink('https://drive.google.com/drive/folders/1xyz')).toBeUndefined();
    for (const f of ['https://drive.google.com/drive/folders/1xyz', 'https://drive.google.com/drive/u/0/folders/1xyz', 'https://drive.google.com/folderview?id=1xyz', 'https://docs.google.com/folder/d/1xyz/edit']) {
      expect(plugin.matches.some((re) => re.test(f))).toBe(true);
    }
    expect(plugin.matches[0].test('https://docs.google.com/document/d/1xyz/edit')).toBe(false);
  });
});

describe('google drive check and download', () => {
  it('reads name and size from the quick linkcheck', async () => {
    const ctx = fakeCtx({ [QUICK]: quick({ fileName: 'Film.mkv', sizeBytes: 123456, downloadUrl: DL, scanResult: 'CLEAN_FILE' }) });
    expect(await plugin.check!(LINK, ctx)).toEqual({ online: true, name: 'Film.mkv', size: 123456 });
  });

  it('downloads the downloadUrl with 6 connections', async () => {
    const ctx = fakeCtx({
      [QUICK]: quick({ fileName: 'Film.mkv', sizeBytes: 123456, downloadUrl: DL, scanResult: 'CLEAN_FILE' }),
      [`GET ${DL}`]: { file: true, url: DL },
    });
    expect(await plugin.resolve(LINK, ctx)).toMatchObject({ url: DL, name: 'Film.mkv', size: 123456, maxConnections: 6 });
  });

  it('confirms the virus-scan warning of big files', async () => {
    const page = `<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
      <input type="hidden" name="id" value="${ID}"><input type="hidden" name="export" value="download">
      <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u2"></form>
      <p class="uc-warning-subcaption">Google Drive can't scan this file for viruses.</p>`;
    const confirmed = `https://drive.usercontent.google.com/download?id=${ID}&export=download&confirm=t&uuid=u2`;
    const ctx = fakeCtx({
      [QUICK]: quick({ fileName: 'Big.iso', sizeBytes: 9e9, scanResult: 'SCAN_CLEAN' }),
      [`GET https://drive.google.com/uc?id=${ID}&export=download`]: { body: page, url: 'https://drive.usercontent.google.com/download?id=x' },
      [`GET ${confirmed}`]: { file: true, url: confirmed },
    });
    expect((await plugin.resolve(LINK, ctx)).url).toBe(confirmed);
  });

  it('finds the confirm link in both page forms', () => {
    expect(confirmUrl(`<a href="/uc?export=download&amp;confirm=t&amp;id=${ID}">Download anyway</a>`, 'https://drive.google.com/uc?id=x')).toBe(
      `https://drive.google.com/uc?export=download&confirm=t&id=${ID}`,
    );
    expect(confirmUrl('<p>nothing</p>', 'https://drive.google.com/')).toBeUndefined();
  });

  it('maps quota, infected, restricted and private files like JD', async () => {
    const run = (data: object) => plugin.resolve(LINK, fakeCtx({ [QUICK]: quick(data) }));
    await expect(run({ scanResult: 'ERROR', disposition: 'QUOTA_EXCEEDED' })).rejects.toMatchObject({ haulKind: 'temporary', haulWait: 3600 });
    await expect(run({ scanResult: 'ERROR', disposition: 'FILE_INFECTED_NOT_OWNER' })).rejects.toMatchObject({ haulKind: 'fatal' });
    await expect(run({ scanResult: 'ERROR', disposition: 'DOWNLOAD_RESTRICTED' })).rejects.toMatchObject({ haulKind: 'fatal' });
    await expect(run({ fileName: 'Doc', sizeBytes: 0 })).rejects.toThrow(/Google-Dokument/);
    const priv = fakeCtx({ [QUICK]: { status: 403, body: '' } });
    await expect(plugin.resolve(LINK, priv)).rejects.toThrow(/private Datei/);
    const gone = fakeCtx({ [QUICK]: { status: 404, body: '' } });
    await expect(plugin.check!(LINK, gone)).rejects.toMatchObject({ haulKind: 'offline' });
    const limited = fakeCtx({ [QUICK]: { status: 429, body: '' } });
    await expect(plugin.resolve(LINK, limited)).rejects.toMatchObject({ haulWait: 300 });
  });

  it('reports the quota page during the download', async () => {
    const ctx = fakeCtx({
      [QUICK]: quick({ fileName: 'Film.mkv', sizeBytes: 5, downloadUrl: DL, scanResult: 'CLEAN_FILE' }),
      [`GET ${DL}`]: { body: '<p class="error-subcaption">Too many users have viewed or downloaded this file recently. Please try accessing the file again later.</p>' },
    });
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'temporary', haulWait: 3600 });
  });
});

describe('google drive folders (JD GoogleDriveCrawler.crawlWebsite)', () => {
  const FID = '1FoLdEr_root-000';
  const KEY = 'AIzaSyAbCdEf-ghijklmnopqrstu_vwxyz123';
  // What JD reads from the folder page: the key pair, the team drive id (hex-escaped
  // _DRIVE_ivd) and the title.
  const ivd = `[null,null,1234567890123,5,"0ATeamDrive123456",null,null]`;
  const hex = [...ivd].map((c) => (/[",\[\]]/.test(c) ? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}` : c)).join('');
  const PAGE = `<html><head><title>My Films – Google Drive</title></head><script>
    var cfg = ["${KEY}","${KEY.slice(0, 6)}Other_key_part",null];
    window['_DRIVE_ivd'] = '${hex}';</script></html>`;
  const files = (req: HttpRequest) => {
    expect(req.headers).toMatchObject({ Origin: 'https://drive.google.com', 'X-Requested-With': 'XMLHttpRequest' });
    expect(req.url).toContain(`key=${KEY}`);
    expect(req.url).toContain('teamDriveId=0ATeamDrive123456');
    const q = decodeURIComponent(/[?&]q=([^&]+)/.exec(req.url)![1]);
    const token = /[?&]pageToken=([^&]+)/.exec(req.url)?.[1];
    if (q.includes(FID) && !token) {
      return {
        body: JSON.stringify({
          nextPageToken: 'p2',
          items: [
            { kind: 'drive#file', id: 'f1', title: 'a.part1.rar', mimeType: 'application/x-rar', fileSize: '100', md5Checksum: 'aa'.repeat(16), sha256Checksum: 'BB'.repeat(32) },
            { kind: 'drive#file', id: 'sub1', title: 'Extras', mimeType: 'application/vnd.google-apps.folder', resourceKey: '0-rk' },
          ],
        }),
      };
    }
    if (q.includes(FID)) {
      return {
        body: JSON.stringify({
          items: [
            // A shortcut stands for its target.
            { kind: 'drive#file', id: 'short', title: 'b.rar', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'f2', targetMimeType: 'application/x-rar' } },
          ],
        }),
      };
    }
    expect(req.headers?.['X-Goog-Drive-Resource-Keys']).toBe('sub1/0-rk');
    return { body: JSON.stringify({ items: [{ kind: 'drive#file', id: 'f3', title: 'x.nfo', fileSize: '3' }] }) };
  };

  it('lists all pages and subfolders and names the package', async () => {
    const ctx = fakeCtx({
      [`GET https://drive.google.com/drive/folders/${FID}`]: { body: PAGE },
      'GET https://clients6.google.com/drive/v2beta/files?': files,
    });
    expect(await plugin.crawl!(`https://drive.google.com/drive/u/0/folders/${FID}?usp=sharing`, ctx)).toEqual({
      packageName: 'My Films',
      files: [
        // SHA-256 before MD5 (JD parseFileInfoAPIAndWebsiteWebAPI).
        { url: 'https://drive.google.com/file/d/f1', name: 'a.part1.rar', size: 100, hash: { type: 'sha256', value: 'bb'.repeat(32) } },
        { url: 'https://drive.google.com/file/d/f2', name: 'b.rar', size: undefined },
        { url: 'https://drive.google.com/file/d/f3', name: 'x.nfo', size: 3 },
      ],
    });
    expect(ctx.waits).toEqual([0.5]);
  });

  it('follows open?id= to a folder or keeps a file', async () => {
    const ctx = fakeCtx({
      'GET https://drive.google.com/open?id=abc': { status: 302, headers: { location: `https://drive.google.com/drive/folders/${FID}` } },
      'GET https://drive.google.com/open?id=file1': { status: 302, headers: { location: `https://drive.google.com/file/d/file1/view` } },
      [`GET https://drive.google.com/drive/folders/${FID}`]: { body: PAGE },
      'GET https://clients6.google.com/drive/v2beta/files?': files,
    });
    expect((await plugin.crawl!('https://drive.google.com/open?id=abc', ctx)).files).toHaveLength(3);
    expect(await plugin.crawl!('https://drive.google.com/open?id=file1', ctx)).toEqual({ files: [{ url: 'https://drive.google.com/file/d/file1/view' }] });
    expect(await plugin.crawl!(LINK, ctx)).toEqual({ files: [{ url: LINK }] });
  });

  it('knows private, missing and unreadable folders', async () => {
    const at = (r: object) => fakeCtx({ [`GET https://drive.google.com/drive/folders/${FID}`]: r });
    const link = `https://drive.google.com/drive/folders/${FID}`;
    await expect(plugin.crawl!(link, at({ status: 404 }))).rejects.toMatchObject({ haulKind: 'offline' });
    await expect(plugin.crawl!(link, at({ url: 'https://accounts.google.com/ServiceLogin' }))).rejects.toMatchObject({ haulKind: 'fatal' });
    await expect(plugin.crawl!(link, at({ body: '<html>nothing</html>' }))).rejects.toMatchObject({ haulKind: 'temporary' });
    await expect(plugin.resolve(link, at({}))).rejects.toThrow(/Ordner-Link/);
  });
});
