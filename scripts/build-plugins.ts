// Bundles every plugin in plugins/<name>/src/index.ts into plugins/dist/<name>.js.
// The output is a plain script that assigns the plugin to `__plugin`; the Rust core
// evaluates it in QuickJS.
// Still esbuild, not Bun.build: Bun.build cannot lower the syntax to es2020 (its own helpers use
// `??=`, class fields stay as they are) and has no `globalName`, so its IIFE would not hand the
// plugin to the core.
import { build } from 'esbuild';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', 'plugins');
const out = join(root, 'dist');
mkdirSync(out, { recursive: true });

const names = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'src', 'index.ts')))
  .map((d) => d.name);

for (const name of names) {
  await build({
    entryPoints: [join(root, name, 'src', 'index.ts')],
    outfile: join(out, `${name}.js`),
    bundle: true,
    format: 'iife',
    globalName: '__plugin',
    platform: 'neutral',
    target: 'es2020',
    legalComments: 'none',
    logLevel: 'warning',
  });
  console.log(`plugins/dist/${name}.js`);
}
