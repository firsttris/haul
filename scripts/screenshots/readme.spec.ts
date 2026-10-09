import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * docs/screenshot.png and docs/social-preview.png: four packages in a haul that serve.mjs
 * started, downloading from its stand-in for the internet. The photo archive finishes and is
 * extracted, five downloads run under a 60 MB/s limit, two wait.
 */

const ROOT = path.resolve(__dirname, '../..');
const DOCS = path.join(ROOT, 'docs');

const PACKAGES = [
  {
    packageName: 'Sintel & Tears of Steel 4K',
    links: [
      'http://download.blender.org/demo/movies/Sintel.2010.4K.HDR.mkv',
      'http://download.blender.org/demo/movies/Tears.of.Steel.2012.2160p.mkv',
    ],
  },
  {
    packageName: 'Linux ISOs',
    links: [
      'http://releases.ubuntu.com/24.04.1/ubuntu-24.04.1-desktop-amd64.iso',
      'http://cdimage.debian.org/debian-cd/13.1.0/amd64/iso-dvd/debian-13.1.0-amd64-DVD-1.iso',
    ],
  },
  {
    packageName: 'Blender Open Movies',
    links: [1, 2, 3].map((n) => `http://download.blender.org/archive/Blender-Open-Movies.part${n}.rar`),
  },
];

test('downloads', async ({ page }) => {
  const api = page.request;
  expect((await api.post('/api/auth/login', { data: { user: 'demo', password: 'demo-password' } })).ok()).toBe(true);
  const settings = await (await api.get('/api/settings')).json();
  const put = await api.put('/api/settings', {
    data: { ...settings, maxParallel: 5, connectionsPerFile: 1, speedLimitKib: 60 * 1024 },
  });
  expect(put.ok()).toBe(true);

  await page.goto('/');
  const add = (packageName: string, links: string[]) =>
    api.post('/api/links', { data: { packageName, links: links.join('\n'), start: true } });

  // First the photos, finished and extracted
  expect((await add('Holiday Photos 2025', ['http://nas.example.com/Holiday-Photos-2025.7z'])).ok()).toBe(true);
  await expect(page.getByText(/extracted/)).toBeVisible();

  for (const p of PACKAGES) expect((await add(p.packageName, p.links)).ok()).toBe(true);
  await expect(page.getByText(/5 active · 2 queued/)).toBeVisible();
  // Long enough for every speed and ETA to settle
  await page.waitForTimeout(15_000);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(DOCS, 'screenshot.png'), animations: 'disabled', caret: 'hide' });
});

// The image for Settings → Social preview on GitHub, with the picture above
test('social preview', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await page.goto(`file://${path.join(ROOT, 'scripts', 'social-preview', 'social-preview.html')}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(DOCS, 'social-preview.png') });
  await page.close();
});
