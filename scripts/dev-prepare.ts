// First step of `bun run dev`: creates .env on the first run, builds the plugins and prints where
// the UI is. The servers are started by `bun run --parallel dev:server dev:ui` after it.
import { copyFileSync, existsSync } from 'node:fs';

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('.env aus .env.example angelegt');
}
const plugins = Bun.spawnSync(['bun', 'scripts/build-plugins.ts'], { stdio: ['inherit', 'inherit', 'inherit'] });
if (plugins.exitCode !== 0) process.exit(plugins.exitCode ?? 1);

console.log('\n  Haul-UI: http://localhost:5173  (Login aus .env, Standard admin / adminadmin)\n');
