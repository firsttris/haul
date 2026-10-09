import { defineConfig } from '@playwright/test';

// The README picture and the social preview: pnpm screenshots (needs target/release/haul and 7z)
export default defineConfig({
  testDir: '.',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  outputDir: '../../test-results/screenshots',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8437',
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    colorScheme: 'dark',
    viewport: { width: 1440, height: 860 },
    deviceScaleFactor: 2,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
  },
  webServer: {
    command: 'node serve.mjs',
    url: 'http://127.0.0.1:8437/api/auth/state',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
