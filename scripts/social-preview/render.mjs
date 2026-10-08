// Renders social-preview.html to docs/social-preview.png (1280 × 640).
// Needs Playwright, which is not a dependency of this repository:
//   npx -y -p playwright node scripts/social-preview/render.mjs
// PLAYWRIGHT_CHROMIUM points to a Chromium binary if Playwright has none installed.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../docs/social-preview.png');
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
await page.goto('file://' + path.join(here, 'social-preview.html'));
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, type: 'png' });
await browser.close();
console.log('written', out);
