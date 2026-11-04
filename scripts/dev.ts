// `bun run dev`: creates .env on first run, builds the plugins, then runs the Rust server
// (:8080) and the Vite UI (:5173, proxies /api) side by side. Each runs in a process group of its
// own; Ctrl+C, SIGTERM (an IDE's stop, `kill`) and SIGHUP (the terminal closed) reach each group
// whole, with what the servers started (7z, esbuild), and when one exits, the other is stopped too.
// Tested in dev.test.ts (`bun test ./scripts/dev.test.ts`, part of `bun run test`).
import { copyFileSync, existsSync } from 'node:fs';
import { constants } from 'node:os';

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('.env aus .env.example angelegt');
}
const plugins = Bun.spawnSync(['bun', 'scripts/build-plugins.ts'], { stdio: ['inherit', 'inherit', 'inherit'] });
if (plugins.exitCode !== 0) process.exit(plugins.exitCode ?? 1);

console.log('\n  Haul-UI: http://localhost:5173  (Login aus .env, Standard admin / adminadmin)\n');

// detached: a process group of its own, so a signal to the group reaches everything inside
const processes = [
  Bun.spawn(['cargo', 'run', '-p', 'haul'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    // Until the UI is built into the binary, :8080 redirects to Vite.
    env: { ...process.env, HAUL_DEV_UI: process.env.HAUL_DEV_UI ?? 'http://localhost:5173' },
    detached: true,
  }),
  Bun.spawn(['bun', 'run', '--cwd', 'ui', 'dev'], { stdio: ['inherit', 'inherit', 'inherit'], detached: true }),
];

const signalAll = (signal: NodeJS.Signals) => {
  for (const p of processes) {
    try {
      process.kill(-p.pid, signal);
    } catch {
      // the group has already exited
    }
  }
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => signalAll(signal));

// Ctrl+Z (SIGTSTP) reaches only dev.ts, the servers' sessions are out of the terminal's reach: stop
// them too, or Vite keeps reading the terminal the shell has taken back. SIGSTOP, as the kernel drops
// SIGTSTP sent to an orphaned group (a session of its own is one); `fg` (SIGCONT) resumes them.
process.on('SIGTSTP', () => {
  signalAll('SIGSTOP');
  process.kill(process.pid, 'SIGSTOP');
});
process.on('SIGCONT', () => signalAll('SIGCONT'));

// The first to exit decides the exit code: its own, or 128 + n when signal n stopped it
const first = await Promise.race(processes.map((p) => p.exited.then(() => p)));
signalAll('SIGTERM');
await Promise.all(processes.map((p) => p.exited));
process.exit(first.signalCode ? 128 + constants.signals[first.signalCode] : (first.exitCode ?? 1));
