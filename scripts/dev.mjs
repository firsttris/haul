// `pnpm dev`: creates .env on first run, builds the plugins, then runs the Rust server
// (:8080) and the Vite UI (:5173, proxies /api) side by side.
import { copyFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import concurrently from 'concurrently';

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('.env aus .env.example angelegt');
}
execSync('node scripts/build-plugins.mjs', { stdio: 'inherit' });

const { result } = concurrently(
  [
    { name: 'server', command: 'cargo run -p haul', prefixColor: 'yellow' },
    { name: 'ui', command: 'pnpm --filter @haul/ui dev', prefixColor: 'cyan' },
  ],
  { killOthersOn: ['failure', 'success'] },
);
result.catch(() => process.exit(1));
