import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeCtx } from '@haul/plugin-sdk/testing';
import type { FakeRoute, HttpRequest } from '@haul/plugin-sdk';
import plugin from '../src/index';

const TOKEN_ROUTE = {
  'POST https://api.gofile.io/accounts': { body: JSON.stringify({ status: 'ok', data: { token: 'tok123' } }) },
};
const wt = (req: HttpRequest, salt: string) => {
  const block = Math.floor(Date.now() / 1000 / 14400);
  return createHash('sha256')
    .update(`${req.headers?.['User-Agent']}::en-US::tok123::${block}::${salt}`)
    .digest('hex');
};
const contents = (code: string, data: unknown, status = 'ok') => ({
  [`GET https://api.gofile.io/contents/${code}?`]: (req: HttpRequest): FakeRoute => {
    expect(req.headers?.Authorization).toBe('Bearer tok123');
    expect(req.headers?.['X-BL']).toBe('en-US');
    expect(req.headers?.['X-Website-Token']).toBe(wt(req, '12af056dacea0b'));
    return { body: JSON.stringify({ status, data }) };
  },
});
const f1 = 'https://store1.gofile.io/download/web/f1/a.part1.rar';
const FOLDER = {
  id: 'uuid-root',
  type: 'folder',
  name: 'My Folder',
  code: 'AbC123',
  canAccess: true,
  children: {
    f1: { id: 'f1', type: 'file', name: 'a.part1.rar', size: 100, link: f1 },
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
const crawled = (id: string, url: string) => `https://gofile.io/d/AbC123#file=${id}&t=tok123&dl=${encodeURIComponent(url)}`;

describe('gofile', () => {
  it('matches folder and file links', () => {
    const re = plugin.matches[0];
    expect(re.test('https://gofile.io/d/AbC123')).toBe(true);
    expect(re.test('https://gofile.io/?c=AbC123#file=f1')).toBe(true);
    expect(re.test('https://gofile.io/')).toBe(false);
    expect(plugin.serial).toBe(true);
  });

  it('crawls a folder with subfolders into files with names and direct links', async () => {
    const ctx = fakeCtx({ ...TOKEN_ROUTE, ...contents('AbC123', FOLDER), ...contents('Sub9', SUB) });
    const r = await plugin.crawl!('https://gofile.io/d/AbC123', ctx);
    expect(r.packageName).toBe('My Folder');
    expect(r.files).toEqual([
      { url: crawled('f1', f1), name: 'a.part1.rar', size: 100 },
      { url: crawled('f2', 'https://store1.gofile.io/download/web/f2/a.part2.rar'), name: 'a.part2.rar', size: 50 },
      // Flagged as malware: no direct link.
      { url: 'https://gofile.io/d/Sub9#file=f3', name: 'x.nfo', size: 3 },
    ]);
    // One guest token for all requests, kept in the jar; the web client's query.
    expect(ctx.requests.filter((r) => r.url.endsWith('/accounts'))).toHaveLength(1);
    expect(ctx.requests[1].url).toContain('pageSize=1000&sortField=createTime');
    expect(ctx.jar.get('accountToken')).toBe('tok123');
  });

  it('keeps a link to one file as that file', async () => {
    const ctx = fakeCtx({ ...TOKEN_ROUTE, ...contents('AbC123', FOLDER), ...contents('Sub9', SUB) });
    const r = await plugin.crawl!('https://gofile.io/d/AbC123#file=f2', ctx);
    expect(r.files.map((f) => f.name)).toEqual(['a.part2.rar']);
  });

  it('resolves a crawled file from its direct link without asking the API', async () => {
    const ctx = fakeCtx({
      [`HEAD ${f1}`]: (req) => {
        expect(req.headers?.Cookie).toBe('accountToken=tok123');
        return { file: true, headers: { 'content-disposition': 'attachment' } };
      },
    });
    const r = await plugin.resolve(crawled('f1', f1), ctx);
    expect(r).toMatchObject({ url: f1, cookies: { accountToken: 'tok123' }, headers: { Referer: 'https://gofile.io/' }, maxConnections: 3 });
    expect(ctx.requests).toHaveLength(1);
  });

  it('lists the folder again when the direct link expired', async () => {
    const ctx = fakeCtx({
      [`HEAD ${f1}`]: { body: '<html>', headers: { 'content-type': 'text/html' } },
      ...TOKEN_ROUTE,
      ...contents('AbC123', FOLDER),
    });
    const r = await plugin.resolve(crawled('f1', f1), ctx);
    expect(r).toMatchObject({ url: f1, name: 'a.part1.rar', size: 100, cookies: { accountToken: 'tok123' } });
  });

  it('resolves a folder with a single file (crawl had failed)', async () => {
    const one = { ...FOLDER, children: { f1: FOLDER.children.f1 } };
    const ctx = fakeCtx({ ...TOKEN_ROUTE, ...contents('AbC123', one) });
    expect(await plugin.resolve('https://gofile.io/d/AbC123', ctx)).toMatchObject({ name: 'a.part1.rar' });
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

  it('backs off on 429 and error-rateLimit', async () => {
    let calls = 0;
    const ctx = fakeCtx({
      ...TOKEN_ROUTE,
      'GET https://api.gofile.io/contents/AbC123': () =>
        ++calls === 1
          ? { status: 429 }
          : calls === 2
            ? { body: JSON.stringify({ status: 'error-rateLimit', data: {} }) }
            : { body: JSON.stringify({ status: 'ok', data: FOLDER }) },
    });
    const r = await plugin.check!('https://gofile.io/d/AbC123#file=f2', ctx);
    expect(r).toEqual({ online: true, name: 'a.part2.rar', size: 50 });
    expect(calls).toBe(3);
  });

  it('gives up with a temporary error while rate-limited', async () => {
    const ctx = fakeCtx({
      ...TOKEN_ROUTE,
      'GET https://api.gofile.io/contents/AbC123': { body: JSON.stringify({ status: 'error-rateLimit', data: {} }) },
    });
    await expect(plugin.crawl!('https://gofile.io/d/AbC123', ctx)).rejects.toMatchObject({ haulKind: 'temporary' });
  });

  it('falls back to the older salt when gofile rejects the token', async () => {
    const ctx = fakeCtx({
      ...TOKEN_ROUTE,
      'GET https://api.gofile.io/contents/AbC123': (req) =>
        req.headers?.['X-Website-Token'] === wt(req, '9844d94d963d30')
          ? { body: JSON.stringify({ status: 'ok', data: FOLDER }) }
          : { body: JSON.stringify({ status: 'error-notPremium', data: {} }) },
    });
    const r = await plugin.crawl!('https://gofile.io/d/AbC123#file=f1', ctx);
    expect(r.files[0].name).toBe('a.part1.rar');
  });

  it('explains password-protected folders', async () => {
    const ctx = fakeCtx({ ...TOKEN_ROUTE, ...contents('Pw1', { type: 'folder', passwordStatus: 'passwordRequired' }) });
    await expect(plugin.crawl!('https://gofile.io/d/Pw1', ctx)).rejects.toThrow(/passwortgeschützt/);
  });
});
