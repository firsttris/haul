import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import { sha1Hex } from '@haul/plugin-sdk';
import type { HttpRequest } from '@haul/plugin-sdk';
import plugin, { chooseExport, confirmUrl, exportName, fileApiKey, parseLink } from '../src/index';

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
    // JD: Google Docs documents are file links too (exported when downloaded).
    expect(parseLink('https://docs.google.com/document/d/1xyz/edit')?.id).toBe('1xyz');
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

describe('google drive with a Google account (JD cookie login)', () => {
  const SECRET = `User-Agent: Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0
[{"domain":".google.com","name":"SAPISID","value":"sap/123","path":"/","secure":true},
 {"domain":".google.com","name":"SID","value":"sid1","path":"/"},
 {"domain":".google.com","name":"ST-1abc","value":"junk","path":"/"}]`;
  const account = (secret = SECRET) => ({ id: 7, user: '', secret });
  const UA = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0';

  it('checks the cookies like JD: my-drive, not the login page, and SAPISID', async () => {
    const ok = fakeCtx(
      {
        'GET https://drive.google.com/drive/my-drive': (req) => {
          expect(req.headers?.['User-Agent']).toBe(UA);
          expect(req.headers?.Cookie).toContain('SAPISID=sap/123');
          return { body: '<html>My Drive</html>' };
        },
      },
      account(),
    );
    expect(await plugin.checkAccount!(ok)).toMatchObject({ valid: true, premium: false });
    // JD loadUserCookies: the ST-… cookies stay out.
    expect([...ok.jar.keys()]).toEqual(['SAPISID', 'SID']);

    const expired = fakeCtx({ 'GET https://drive.google.com/drive/my-drive': { url: 'https://accounts.google.com/ServiceLogin?continue=x' } }, account());
    await expect(plugin.checkAccount!(expired)).rejects.toMatchObject({ haulKind: 'account', message: expect.stringContaining('abgelaufen') });

    const incomplete = fakeCtx({ 'GET https://drive.google.com/drive/my-drive': { body: 'ok' } }, account('SID=sid1; HSID=h1'));
    await expect(plugin.checkAccount!(incomplete)).rejects.toThrow(/SAPISID/);

    const nothing = fakeCtx({}, account('this is not a cookie export'));
    await expect(plugin.checkAccount!(nothing)).rejects.toMatchObject({ haulKind: 'account' });
  });

  it('downloads with the cookies and the browser User-Agent, falling back to /u/0/uc', async () => {
    const ctx = fakeCtx(
      {
        [QUICK]: (req) => {
          expect(req.headers?.['User-Agent']).toBe(UA);
          return { body: `)]}'\n${JSON.stringify({ fileName: 'Privat.mkv', sizeBytes: 42, scanResult: 'CLEAN_FILE' })}` };
        },
        [`GET https://drive.google.com/u/0/uc?id=${ID}&export=download`]: { file: true },
      },
      account(),
    );
    const r = await plugin.resolve(LINK, ctx);
    expect(r).toMatchObject({ url: `https://drive.google.com/u/0/uc?id=${ID}&export=download`, name: 'Privat.mkv' });
    expect(r.headers?.['User-Agent']).toBe(UA);
  });

  it('says that the account has no access to a private file', async () => {
    const ctx = fakeCtx({ [QUICK]: { status: 403, body: '' } }, account());
    await expect(plugin.resolve(LINK, ctx)).rejects.toThrow(/dieses Google-Konto hat keinen Zugriff/);
  });

  it('lists a private folder with SAPISIDHASH and X-Goog-Authuser (JD prepBrowserWebAPI)', async () => {
    const folder = '1PrivateFolderId';
    const page = `<title>Privat - Google Drive</title> "AIzaSyAbcdefghijklmnopqrstuvwxyz0123","AIzaSyAbcdefghijk",null`;
    const before = Math.floor(Date.now() / 1000);
    const ctx = fakeCtx(
      {
        [`GET https://drive.google.com/drive/folders/${folder}`]: { body: page },
        'GET https://clients6.google.com/drive/v2beta/files?': (req) => {
          const m = /^SAPISIDHASH (\d+)_([0-9a-f]{40})$/.exec(req.headers?.Authorization ?? '');
          expect(m).not.toBeNull();
          const ts = Number(m![1]);
          expect(ts).toBeGreaterThanOrEqual(before);
          expect(m![2]).toBe(sha1Hex(`${ts} sap/123 https://drive.google.com`));
          expect(req.headers?.['X-Goog-Authuser']).toBe('0');
          return { body: JSON.stringify({ items: [{ kind: 'drive#file', id: 'p1', title: 'geheim.zip', fileSize: '9' }] }) };
        },
      },
      account(),
    );
    const r = await plugin.crawl!(`https://drive.google.com/drive/folders/${folder}`, ctx);
    expect(r.files).toEqual([{ url: 'https://drive.google.com/file/d/p1', name: 'geheim.zip', size: 9 }]);
    // Without an account: no Authorization header.
    const anon = fakeCtx({
      [`GET https://drive.google.com/drive/folders/${folder}`]: { body: page },
      'GET https://clients6.google.com/drive/v2beta/files?': (req) => {
        expect(req.headers?.Authorization).toBeUndefined();
        return { body: JSON.stringify({ items: [] }) };
      },
    });
    await plugin.crawl!(`https://drive.google.com/drive/folders/${folder}`, anon);
  });
});

describe('google documents (JD parseGoogleDocumentPropertiesAPIAndSetFilename)', () => {
  const links = {
    'application/pdf': 'https://docs.google.com/feeds/download/documents/export/Export?id=D1&exportFormat=pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'https://docs.google.com/feeds/download/documents/export/Export?id=D1&exportFormat=docx',
    'application/vnd.oasis.opendocument.text': 'https://docs.google.com/feeds/download/documents/export/Export?id=D1&exportFormat=odt',
    'text/markdown': 'https://docs.google.com/feeds/download/documents/export/Export?id=D1&exportFormat=markdown',
  };
  const DOC = 'application/vnd.google-apps.document';

  it('picks the format: the title’s own, then Google’s download format, then JD’s fallback, then ZIP', () => {
    expect(chooseExport('D1', 'Bericht.pdf', DOC, links).ext).toBe('pdf');
    expect(chooseExport('D1', 'Notizen.md', DOC, links).ext).toBe('md');
    expect(chooseExport('D1', 'Bericht', DOC, links)).toEqual({ ext: 'docx', url: links['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] });
    expect(chooseExport('S1', 'Tabelle', 'application/vnd.google-apps.spreadsheet', { a: 'https://docs.google.com/spreadsheets/export?id=S1&exportFormat=xlsx', b: 'https://docs.google.com/spreadsheets/export?id=S1&exportFormat=pdf' }).ext).toBe('xlsx');
    expect(chooseExport('X1', 'Zeichnung', 'application/vnd.google-apps.drawing', { a: 'https://docs.google.com/drawings/export?id=X1&exportFormat=svg', b: 'https://docs.google.com/drawings/export?id=X1&exportFormat=pdf' }).ext).toBe('pdf');
    expect(chooseExport('D1', 'Unbekannt', DOC, undefined)).toEqual({
      ext: 'zip',
      url: 'https://docs.google.com/feeds/download/documents/export/Export?id=D1&exportFormat=zip',
    });
    expect(exportName('Bericht', 'docx')).toBe('Bericht.docx');
    expect(exportName('Bericht.PDF', 'pdf')).toBe('Bericht.PDF');
    expect(fileApiKey('x,"AIzaFileKey",null,"/drive/v2beta",y')).toBe('AIzaFileKey');
    expect(fileApiKey('"/drive/v2internal","AIzaInternal"')).toBe('AIzaInternal');
  });

  it('exports a document found by its size 0: file page, details, export', async () => {
    const quickDoc = `POST https://drive.google.com/uc?id=D1&authuser=0&export=download`;
    const EXPORT = links['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    const ctx = fakeCtx({
      [quickDoc]: { body: `)]}'\n${JSON.stringify({ fileName: 'Bericht', sizeBytes: 0 })}` },
      'GET https://drive.google.com/file/d/D1/view': { body: '<script>x,"AIzaFileKey",null,"/drive/v2beta"</script>' },
      'GET https://content.googleapis.com/drive/v2beta/files/D1?': (req) => {
        expect(req.url).toContain('key=AIzaFileKey');
        expect(req.url).toContain('exportLinks');
        return { body: JSON.stringify({ id: 'D1', title: 'Bericht', mimeType: DOC, exportLinks: links }) };
      },
      [`GET ${EXPORT}`]: { file: true },
    });
    expect(await plugin.resolve('https://docs.google.com/document/d/D1/edit', ctx)).toMatchObject({ url: EXPORT, name: 'Bericht.docx', maxConnections: 1 });
  });

  it('uses v2internal with the account (JD)', async () => {
    const quickDoc = `POST https://drive.google.com/uc?id=D1&authuser=0&export=download`;
    const ZIP = 'https://docs.google.com/feeds/download/documents/export/Export?id=D1&exportFormat=zip';
    const ctx = fakeCtx(
      {
        [quickDoc]: { body: `)]}'\n${JSON.stringify({ fileName: 'X', sizeBytes: 0 })}` },
        'GET https://drive.google.com/file/d/D1/view': { body: '"/drive/v2internal","AIzaInternal"' },
        'GET https://clients6.google.com/drive/v2internal/files/D1?': (req) => {
          expect(req.headers?.Authorization).toMatch(/^SAPISIDHASH /);
          return { body: JSON.stringify({ id: 'D1', title: 'X', mimeType: 'application/vnd.google-apps.form' }) };
        },
        [`GET ${ZIP}`]: { file: true },
      },
      { id: 1, user: '', secret: 'SAPISID=s1; SID=x' },
    );
    expect(await plugin.resolve('https://drive.google.com/file/d/D1/view', ctx)).toMatchObject({ url: ZIP, name: 'X.zip' });
  });
});
