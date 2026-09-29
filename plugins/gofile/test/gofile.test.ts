import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import type { HttpRequest } from '@haul/plugin-sdk';
import plugin from '../src/index';

const TOKEN_ROUTE = {
  'POST https://api.gofile.io/accounts': { body: JSON.stringify({ status: 'ok', data: { token: 'tok123' } }) },
};
const contents = (code: string, data: unknown, status = 'ok') => ({
  [`GET https://api.gofile.io/contents/${code}?contentId=${code}`]: (req: HttpRequest) => {
    expect(req.headers?.Authorization).toBe('Bearer tok123');
    const ua = req.headers?.['User-Agent'];
    const block = Math.floor(Date.now() / 1000 / 14400);
    const wt = createHash('sha256').update(`${ua}::::tok123::${block}::9844d94d963d30`).digest('hex');
    expect(req.headers?.['X-Website-Token']).toBe(wt);
    return { body: JSON.stringify({ status, data }) };
  },
});
const FOLDER = {
  id: 'uuid-root',
  type: 'folder',
  name: 'My Folder',
  code: 'AbC123',
  canAccess: true,
  children: {
    f1: { id: 'f1', type: 'file', name: 'a.part1.rar', size: 100, link: 'https://store1.gofile.io/download/web/f1/a.part1.rar' },
    f2: { id: 'f2', type: 'file', name: 'a.part2.rar', size: 50, link: 'https://store1.gofile.io/download/web/f2/a.part2.rar' },
    sub: { id: 'sub', type: 'folder', name: 'Extras', code: 'Sub9' },
  },
};
const SUB = {
  id: 'sub',
  type: 'folder',
  name: 'Extras',
  code: 'Sub9',
  canAccess: true,
  children: { f3: { id: 'f3', type: 'file', name: 'x.nfo', size: 3, link: 'https://store2.gofile.io/download/web/f3/x.nfo', viruses: ['bad'] } },
};

describe('gofile', () => {
  it('matches folder and file links', () => {
    const re = plugin.matches[0];
    expect(re.test('https://gofile.io/d/AbC123')).toBe(true);
    expect(re.test('https://gofile.io/?c=AbC123#file=f1')).toBe(true);
    expect(re.test('https://gofile.io/')).toBe(false);
  });

  it('crawls a folder with subfolders into files', async () => {
    const ctx = fakeCtx({ ...TOKEN_ROUTE, ...contents('AbC123', FOLDER), ...contents('Sub9', SUB) });
    const r = await plugin.crawl!('https://gofile.io/d/AbC123', ctx);
    expect(r.packageName).toBe('My Folder');
    expect(r.files).toEqual([
      { url: 'https://gofile.io/d/AbC123#file=f1', name: 'a.part1.rar', size: 100 },
      { url: 'https://gofile.io/d/AbC123#file=f2', name: 'a.part2.rar', size: 50 },
      { url: 'https://gofile.io/d/Sub9#file=f3', name: 'x.nfo', size: 3 },
    ]);
    // One guest token for all requests, kept in the jar.
    expect(ctx.requests.filter((r) => r.url.endsWith('/accounts'))).toHaveLength(1);
    expect(ctx.jar.get('accountToken')).toBe('tok123');
  });

  it('keeps a link to one file as that file', async () => {
    const ctx = fakeCtx({ ...TOKEN_ROUTE, ...contents('AbC123', FOLDER), ...contents('Sub9', SUB) });
    const r = await plugin.crawl!('https://gofile.io/d/AbC123#file=f2', ctx);
    expect(r.files.map((f) => f.name)).toEqual(['a.part2.rar']);
  });

  it('resolves a file with token cookie and referer', async () => {
    const ctx = fakeCtx({ ...TOKEN_ROUTE, ...contents('AbC123', FOLDER) });
    const r = await plugin.resolve('https://gofile.io/d/AbC123#file=f1', ctx);
    expect(r).toMatchObject({
      url: 'https://store1.gofile.io/download/web/f1/a.part1.rar',
      name: 'a.part1.rar',
      size: 100,
      cookies: { accountToken: 'tok123' },
      headers: { Referer: 'https://gofile.io/' },
      maxConnections: 3,
    });
  });

  it('refuses files flagged as malware', async () => {
    const ctx = fakeCtx({ ...TOKEN_ROUTE, ...contents('Sub9', SUB) });
    await expect(plugin.resolve('https://gofile.io/d/Sub9#file=f3', ctx)).rejects.toMatchObject({ haulKind: 'fatal' });
  });

  it('reports deleted folders and files as offline', async () => {
    const gone = fakeCtx({ ...TOKEN_ROUTE, ...contents('Gone1', {}, 'error-notFound') });
    await expect(plugin.crawl!('https://gofile.io/d/Gone1', gone)).rejects.toMatchObject({ haulKind: 'offline' });
    const moved = fakeCtx({ ...TOKEN_ROUTE, ...contents('AbC123', FOLDER) });
    await expect(plugin.resolve('https://gofile.io/d/AbC123#file=nope', moved)).rejects.toMatchObject({ haulKind: 'offline' });
    expect((await plugin.check!('https://gofile.io/d/AbC123#file=nope', moved)).online).toBe(false);
  });

  it('waits and retries on 429', async () => {
    let calls = 0;
    const ctx = fakeCtx({
      ...TOKEN_ROUTE,
      'GET https://api.gofile.io/contents/AbC123': () =>
        ++calls < 3 ? { status: 429 } : { body: JSON.stringify({ status: 'ok', data: FOLDER }) },
    });
    const r = await plugin.check!('https://gofile.io/d/AbC123#file=f2', ctx);
    expect(r).toEqual({ online: true, name: 'a.part2.rar', size: 50 });
    expect(calls).toBe(3);
  });

  it('explains password-protected folders', async () => {
    const ctx = fakeCtx({ ...TOKEN_ROUTE, ...contents('Pw1', { type: 'folder', passwordStatus: 'passwordRequired' }) });
    await expect(plugin.crawl!('https://gofile.io/d/Pw1', ctx)).rejects.toThrow(/passwortgeschützt/);
  });
});
