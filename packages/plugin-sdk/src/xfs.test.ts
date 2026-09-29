import { describe, expect, it } from 'vitest';
import { fakeCtx } from './testing';
import { createXfsPlugin, parseDate } from './xfs';

describe('parseDate', () => {
  it('reads common formats', () => {
    expect(parseDate('2026-10-12 23:59:59')).toBe(Date.UTC(2026, 9, 12));
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

  it('mentions the API key in its form hint', () => {
    expect((plugin.account?.help as { de: string }).de).toContain('API-Key');
  });
});

describe('free mode helpers (JD)', () => {
  it('parses waits, countdowns and plain-text captchas', async () => {
    const { parseWait, countdown, plainTextCaptcha } = await import('./xfs');
    expect(parseWait('You have to wait 2 minutes, 10 seconds till next download')).toBe(131);
    expect(parseWait('You have reached the download limit')).toBe(3600);
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
