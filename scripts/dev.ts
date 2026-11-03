// `bun run dev`: creates .env on first run, builds the plugins, then runs the Rust server
// (:8080) and the Vite UI (:5173, proxies /api) side by side. Ctrl+C reaches both; when one
// exits, the other is stopped too.
import { copyFileSync, existsSync } from 'node:fs';

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('.env aus .env.example angelegt');
}
const plugins = Bun.spawnSync(['bun', 'scripts/build-plugins.ts'], { stdio: ['inherit', 'inherit', 'inherit'] });
if (plugins.exitCode !== 0) process.exit(plugins.exitCode ?? 1);

console.log('\n  Haul-UI: http://localhost:5173  (Login aus .env, Standard admin / adminadmin)\n');

const processes = [
  Bun.spawn(['cargo', 'run', '-p', 'haul'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    // Until the UI is built into the binary, :8080 redirects to Vite.
    env: { ...process.env, HAUL_DEV_UI: process.env.HAUL_DEV_UI ?? 'http://localhost:5173' },
  }),
  Bun.spawn(['bun', 'run', '--cwd', 'ui', 'dev'], { stdio: ['inherit', 'inherit', 'inherit'] }),
];

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const p of processes) p.kill(signal);
  });
}

const code = await Promise.race(processes.map((p) => p.exited));
for (const p of processes) p.kill();
await Promise.all(processes.map((p) => p.exited));
process.exit(code);
