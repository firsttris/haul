import { describe, expect, it } from 'vitest';
import { fakeCtx } from './testing';
import { createXfsPlugin, parseDate } from './xfs';

describe('parseDate', () => {
  it('reads common formats', () => {
    // With a time (XFS API, JD compares to the second) and without.
    expect(parseDate('2026-10-12 23:59:59')).toBe(Date.UTC(2026, 9, 12, 23, 59, 59));
    expect(parseDate('2026-10-12')).toBe(Date.UTC(2026, 9, 12));
    expect(parseDate('12 October 2026')).toBe(Date.UTC(2026, 9, 12));
    expect(parseDate('October 12, 2026')).toBe(Date.UTC(2026, 9, 12));
    expect(parseDate('bald')).toBeUndefined();
  });
});

describe('XFS API-key accounts', () => {
  const plugin = createXfsPlugin({
    id: 'x',
    name: 'X',
    version: 1,
    domains: ['x.example'],
    apiBase: 'https://x.example/api',
    userApiKeys: true,
  });
  const LINK = 'https://x.example/abcdefghijkl';

  it('uses the API with an empty user', async () => {
    const ctx = fakeCtx(
      {
        'GET https://x.example/api/file/direct_link?key=K&file_code=abcdefghijkl': {
          body: JSON.stringify({ status: 200, result: { url: 'https://s1.x.example/d/API/f.rar', size: 42 } }),
        },
        'GET https://x.example/api/account/info?key=K': {
          body: JSON.stringify({ status: 200, result: { premium_expire: '2099-05-01 00:00:00', traffic_left: 1024 } }),
        },
        'GET https://x.example/api/file/info?key=K': {
          body: JSON.stringify({ status: 200, result: [{ status: 404, file_code: 'abcdefghijkl' }] }),
        },
      },
      { id: 2, user: '', secret: 'K' },
    );
    expect(await plugin.resolve(LINK, ctx)).toMatchObject({ url: 'https://s1.x.example/d/API/f.rar', size: 42 });
    expect(await plugin.checkAccount!(ctx)).toMatchObject({ valid: true, premium: true, trafficLeft: 1024 ** 3 });
    expect((await plugin.check!(LINK, ctx)).online).toBe(false);
  });

  it('reads the account like JD: premim_expire typo, server time, premium_bandwidth first', async () => {
    const info = (result: object, server_time?: string) =>
      plugin.checkAccount!(
        fakeCtx({ 'GET https://x.example/api/account/info?key=K': { body: JSON.stringify({ status: 200, server_time, result }) } }, { id: 2, user: '', secret: 'K' }),
      );
    expect(await info({ premim_expire: '2099-05-01 00:00:00' })).toMatchObject({ premium: true, validUntil: Date.UTC(2099, 4, 1) });
    // Expired by the server's clock, even though ours might say otherwise.
    expect(await info({ premium_expire: '2030-01-01 10:00:00' }, '2030-01-01 10:00:01')).toMatchObject({ premium: false });
    expect(await info({ premium_expire: '2099-01-01 00:00:00', premium_bandwidth: '5 GB', traffic_left: '1 GB' })).toMatchObject({ trafficLeft: 5 * 1024 ** 3 });
  });

  it('mentions the API key in its form hint', () => {
    expect((plugin.account?.help as { de: string }).de).toContain('API-Key');
  });
});

describe('free mode helpers (JD)', () => {
  it('parses waits, countdowns and plain-text captchas', async () => {
    const { parseWait, countdown, plainTextCaptcha } = await import('./xfs');
    expect(parseWait('You have to wait 2 minutes, 10 seconds till next download')).toBe(131);
    expect(parseWait('You have reached the download limit')).toBe(3600);
    expect(parseWait('Please wait 3 min')).toBe(181);
    expect(parseWait('try again in 2 hrs')).toBe(7201);
    expect(parseWait('wait 1h 5m 30s')).toBe(3931);
    expect(parseWait('45 secs left')).toBe(46);
    expect(countdown('<span id="countdown_str">Wait <span id="x">60</span> seconds</span>')).toBe(60);
    expect(countdown('<span class="seconds">30</span>')).toBe(30);
    expect(countdown('nothing')).toBeUndefined();
    const spans = [
      [20, 50],
      [0, 52],
    ].map(([p, d]) => `<span style='position:absolute;padding-left:${p}px;padding-top:2px;'>&#${d};</span>`);
    expect(plainTextCaptcha(spans.join(''))).toBe('42');
  });
});

describe('XFS free downloads: what is final', () => {
  const plugin = createXfsPlugin({ id: 'x', name: 'X', version: 1, domains: ['x.example'], free: true });
  const LINK = 'https://x.example/abcdefghijkl';

  it('takes a 404 for offline, but not a 404 from Cloudflare or maintenance', async () => {
    const page = (body: string) => fakeCtx({ 'GET https://x.example/abcdefghijkl': { status: 404, body } });
    await expect(plugin.resolve(LINK, page('<h1>Not Found</h1>'))).rejects.toMatchObject({ haulKind: 'offline' });
    expect(await plugin.check!(LINK, page('<h1>Not Found</h1>'))).toEqual({ online: false });
    const cf = '<div id="cf-error-details"><h1>Error 404</h1></div>';
    await expect(plugin.resolve(LINK, page(cf))).rejects.toMatchObject({ haulKind: 'temporary' });
    await expect(plugin.check!(LINK, page(cf))).rejects.toMatchObject({ haulKind: 'temporary' });
    await expect(plugin.resolve(LINK, page('<p>This server is in maintenance mode</p>'))).rejects.toMatchObject({ haulKind: 'temporary' });
  });

  it('ignores premium-only texts in HTML comments', async () => {
    const ctx = fakeCtx({
      'GET https://x.example/abcdefghijkl': { body: '<!-- <div>This file is available for Premium Users only</div> --><p>Please try again</p>' },
    });
    await expect(plugin.resolve(LINK, ctx)).rejects.toMatchObject({ haulKind: 'temporary' });
    const premium = fakeCtx({ 'GET https://x.example/abcdefghijkl': { body: '<div>This file is available for Premium Users only</div>' } });
    await expect(plugin.resolve(LINK, premium)).rejects.toMatchObject({ haulKind: 'fatal' });
  });
});
