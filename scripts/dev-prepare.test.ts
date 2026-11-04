// scripts/dev-prepare.ts, the first step of `bun run dev`, in a sandbox with a stand-in plugin build
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PREPARE = resolve(import.meta.dir, 'dev-prepare.ts');
let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** Runs dev-prepare.ts in a checkout with `.env.example` and a plugin build exiting with `pluginsExit` */
function prepare(pluginsExit = 0) {
  dir ||= mkdtempSync(join(tmpdir(), 'haul-dev-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, '.env.example'), 'HAUL_DEV_UI=http://localhost:5173\n');
  writeFileSync(join(dir, 'scripts', 'build-plugins.ts'), `process.exit(${pluginsExit});\n`);
  return Bun.spawnSync([process.execPath, PREPARE], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('creates .env from .env.example on the first run', () => {
  expect(prepare().exitCode).toBe(0);
  expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('HAUL_DEV_UI=http://localhost:5173\n');
});

test('keeps an existing .env', () => {
  dir = mkdtempSync(join(tmpdir(), 'haul-dev-'));
  writeFileSync(join(dir, '.env'), 'HAUL_USER=me\n');
  expect(prepare().exitCode).toBe(0);
  expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('HAUL_USER=me\n');
});

test('fails with the plugin build, so `bun run dev` starts no server', () => {
  const run = prepare(3);
  expect(run.exitCode).toBe(3);
  expect(run.stdout.toString()).not.toContain('Haul-UI');
});
