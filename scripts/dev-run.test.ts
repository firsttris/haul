// The `dev` script of package.json, run by `bun run dev` in a sandbox with stand-ins for
// `cargo run -p haul`, `bun run --cwd ui dev` and the plugin build: what the servers get to see.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

let dir = '';
afterEach(() => {
  for (const name of ['server', 'ui']) {
    const file = join(dir, `${name}.pids`);
    if (!existsSync(file)) continue;
    for (const pid of readFileSync(file, 'utf8').split(' ').map(Number)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

// A server stand-in: notes what it sees, then waits (a sleep as its child)
const SERVER = `
const name = process.argv[2];
const child = Bun.spawn(['sleep', '600'], { stdio: ['ignore', 'ignore', 'ignore'] });
await Bun.write(import.meta.dir + '/' + name + '.json', JSON.stringify({
  FORCE_COLOR: process.env.FORCE_COLOR ?? null,
  CARGO_TERM_COLOR: process.env.CARGO_TERM_COLOR ?? null,
}));
await Bun.write(import.meta.dir + '/' + name + '.pids', process.pid + ' ' + child.pid);
await child.exited;
`;

function sandbox() {
  dir = mkdtempSync(join(tmpdir(), 'haul-dev-run-'));
  for (const sub of ['bin', 'scripts', 'ui']) mkdirSync(join(dir, sub));
  const pick = ['dev', 'dev:server', 'dev:ui'];
  const own = Object.fromEntries(pick.map((name) => [name, scripts[name]]));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sandbox', private: true, scripts: own }));
  copyFileSync(join(ROOT, 'scripts', 'dev-prepare.ts'), join(dir, 'scripts', 'dev-prepare.ts'));
  writeFileSync(join(dir, 'scripts', 'build-plugins.ts'), 'process.exit(0);\n');
  writeFileSync(join(dir, '.env.example'), 'HAUL_DEV_UI=http://localhost:5173\n');
  writeFileSync(join(dir, 'server.ts'), SERVER);
  writeFileSync(join(dir, 'bin', 'cargo'), `#!/bin/sh\nexec "${process.execPath}" "${dir}/server.ts" server\n`);
  chmodSync(join(dir, 'bin', 'cargo'), 0o755);
  writeFileSync(
    join(dir, 'ui', 'package.json'),
    JSON.stringify({ name: 'ui', scripts: { dev: `"${process.execPath}" ../server.ts ui` } }),
  );
}

/** Runs `bun run dev` in a terminal (a pty from Bun.spawn) or with its output in a pipe */
async function seen(terminal: boolean) {
  sandbox();
  const { FORCE_COLOR: _f, CARGO_TERM_COLOR: _c, NO_COLOR: _n, ...env } = process.env;
  const proc = Bun.spawn([process.execPath, 'run', 'dev'], {
    cwd: dir,
    env: { ...env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    ...(terminal ? { terminal: { cols: 80, rows: 24, data() {} } } : { stdio: ['ignore', 'pipe', 'pipe'] as const }),
  });
  const files = ['server', 'ui'].map((name) => join(dir, `${name}.pids`));
  const end = Date.now() + 10_000;
  while (!files.every(existsSync) && Date.now() < end) await Bun.sleep(50);
  proc.kill('SIGKILL');
  return ['server', 'ui'].map((name) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')));
}

// --parallel pipes the scripts' output for its name prefix, so cargo and Vite (picocolors) see no
// terminal and would drop their colours, which the old scripts/dev.ts kept by passing it on.
test('in a terminal, cargo and Vite are told to keep their colours', async () => {
  expect(await seen(true)).toEqual([
    { FORCE_COLOR: '1', CARGO_TERM_COLOR: 'always' },
    { FORCE_COLOR: '1', CARGO_TERM_COLOR: 'always' },
  ]);
}, 20_000);

test('with the output in a pipe, no colours are forced', async () => {
  expect(await seen(false)).toEqual([
    { FORCE_COLOR: null, CARGO_TERM_COLOR: null },
    { FORCE_COLOR: null, CARGO_TERM_COLOR: null },
  ]);
}, 20_000);
