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
