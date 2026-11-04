// `bun run dev` (scripts/dev.ts) with stand-ins for `cargo run -p haul`, `bun run --cwd ui dev` and
// the plugin build: what is left running when dev.ts is stopped or one server exits. As with the
// real commands, `cargo` execs the server (cargo run replaces itself with the binary) and `bun run`
// starts it as its child; each server starts a process of its own, as haul starts 7z or unrar to
// extract and Vite starts esbuild.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DEV = resolve(import.meta.dir, 'dev.ts');

let dir = '';
let pids: number[] = [];
let dev: Bun.Subprocess | undefined;

afterEach(() => {
  for (const pid of [...pids, dev?.pid ?? 0]) {
    if (!pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  pids = [];
  dev = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

// A server stand-in: notes its pid and its child's and the HAUL_DEV_UI it got, then waits on the
// child (a sleep with the default signal handling), or, with SERVER_EXIT or UI_EXIT set, exits
// with that code once both servers run.
const SERVER = `
const [name] = process.argv.slice(2);
const dir = process.env.SANDBOX;
const child = Bun.spawn(['sleep', '600'], { stdio: ['ignore', 'ignore', 'ignore'] });
await Bun.write(dir + '/' + name + '.env', process.env.HAUL_DEV_UI ?? '');
await Bun.write(dir + '/' + name + '.pids', process.pid + ' ' + child.pid);
const exit = process.env[name.toUpperCase() + '_EXIT'];
if (exit) {
  while (!(await Bun.file(dir + '/ui.pids').exists()) || !(await Bun.file(dir + '/server.pids').exists())) await Bun.sleep(50);
  child.kill('SIGKILL');
  process.exit(Number(exit));
}
await child.exited;
`;

/** A checkout with `.env.example`, a plugin build, a `cargo` on PATH and a ui package */
function sandbox({ pluginsExit = 0 } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'haul-dev-'));
  const bin = join(dir, 'bin');
  for (const sub of ['bin', 'scripts', 'ui']) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, '.env.example'), 'HAUL_DEV_UI=http://localhost:5173\n');
  writeFileSync(join(dir, 'server.ts'), SERVER);
  writeFileSync(join(dir, 'scripts', 'build-plugins.ts'), `process.exit(${pluginsExit});\n`);
  writeFileSync(join(bin, 'cargo'), `#!/bin/sh\nexec "${process.execPath}" "${dir}/server.ts" server\n`);
  chmodSync(join(bin, 'cargo'), 0o755);
  writeFileSync(
    join(dir, 'ui', 'package.json'),
    JSON.stringify({ name: 'ui', scripts: { dev: `exec "${process.execPath}" ../server.ts ui` } }),
  );
  return bin;
}

/** Starts dev.ts in a fresh sandbox, without HAUL_DEV_UI so its default applies */
function start(env: Record<string, string> = {}, pluginsExit = 0) {
  const bin = sandbox({ pluginsExit });
  const { HAUL_DEV_UI: _, ...inherited } = process.env;
  dev = Bun.spawn([process.execPath, DEV], {
    cwd: dir,
    env: { ...inherited, PATH: `${bin}:${process.env.PATH}`, SANDBOX: dir, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return dev;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await Bun.sleep(50);
  }
}

const NAMES = ['haul', "haul's child (7z)", 'vite', "vite's child (esbuild)"];

/** Waits for both stand-ins and notes their pids and their children's */
async function started() {
  const files = ['server.pids', 'ui.pids'].map((name) => join(dir, name));
  await until(() => files.every((file) => existsSync(file) && readFileSync(file, 'utf8').includes(' ')));
  pids = files.flatMap((file) => readFileSync(file, 'utf8').trim().split(' ').map(Number));
}

/** What is still running of what dev.ts started, once everything had 2 s to stop */
async function leftovers() {
  await until(() => pids.every((pid) => !alive(pid)), 2_000).catch(() => {});
  return NAMES.filter((_, i) => alive(pids[i] ?? 0));
}

for (const [signal, number] of [
  ['SIGINT', 2],
  ['SIGTERM', 15],
  ['SIGHUP', 1],
] as const) {
  test(`${signal} to dev.ts stops both servers and what they started`, async () => {
    const proc = start();
    await started();

    proc.kill(signal);
    const code = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => 'still running')]);

    expect(await leftovers()).toEqual([]);
    expect(code).toBe(128 + number);
  }, 20_000);
}

/** The process states `ps` shows (T: stopped), one letter per pid */
function states() {
  const ps = Bun.spawnSync(['ps', '-o', 'stat=', '-p', pids.join(',')]);
  return ps.stdout.toString().trim().split('\n').map((line) => line.trim()[0]);
}

// Ctrl+Z reaches only dev.ts: the servers run in sessions of their own. Left running, Vite
// would keep reading the terminal and swallow what is typed into the shell.
test('SIGTSTP (Ctrl+Z) to dev.ts stops both servers and what they started, SIGCONT (fg) resumes them', async () => {
  const proc = start();
  await started();

  proc.kill('SIGTSTP');
  await until(() => states().every((state) => state === 'T'), 3_000).catch(() => {});
  expect(states()).toEqual(['T', 'T', 'T', 'T']);

  proc.kill('SIGCONT');
  await until(() => states().every((state) => state !== 'T'), 3_000).catch(() => {});
  expect(states().filter((state) => state === 'T')).toEqual([]);
}, 20_000);

test('when one server exits, the other is stopped and dev.ts exits with its code', async () => {
  const proc = start({ SERVER_EXIT: '3' });
  await started();

  const code = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => 'still running')]);

  expect(await leftovers()).toEqual([]);
  expect(code).toBe(3);
}, 20_000);

test('creates .env and passes HAUL_DEV_UI to the server', async () => {
  start();
  await started();
  expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('HAUL_DEV_UI=http://localhost:5173\n');
  expect(readFileSync(join(dir, 'server.env'), 'utf8')).toBe('http://localhost:5173');
}, 20_000);

test('a failing plugin build aborts before any server starts', async () => {
  const proc = start({}, 4);
  expect(await proc.exited).toBe(4);
  expect(existsSync(join(dir, 'server.pids'))).toBe(false);
  expect(existsSync(join(dir, 'ui.pids'))).toBe(false);
}, 20_000);
