// Builds the extension for Chrome and Firefox into dist/chrome and dist/firefox from one
// source: the scripts are bundled with Bun.build, the manifest differs only where the browsers do
// (service worker vs. event page, Firefox's add-on id).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dir;
// The extension ships with every Haul release, so it carries Haul's version (Cargo.toml, which
// the bump workflow raises): browsers only update an add-on whose version went up.
const cargo = readFileSync(join(root, '..', 'Cargo.toml'), 'utf8');
const version = /\[workspace\.package\][^[]*?\bversion\s*=\s*"([^"]+)"/.exec(cargo)?.[1];
if (!version) throw new Error('no [workspace.package] version in Cargo.toml');
const pages = ['http://*/*', 'https://*/*'];

const manifest = (browser: string) => ({
  manifest_version: 3,
  name: '__MSG_extName__',
  description: '__MSG_extDescription__',
  version,
  default_locale: 'en',
  icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  action: { default_popup: 'popup.html', default_title: '__MSG_extName__' },
  options_ui: { page: 'options.html', open_in_tab: true },
  background:
    browser === 'firefox'
      ? { scripts: ['background.js'], type: 'module' }
      : { service_worker: 'background.js', type: 'module' },
  permissions: ['contextMenus', 'storage'],
  // The Haul server's address is only known after setup; the settings page asks for it then.
  optional_host_permissions: pages,
  content_scripts: [
    // Click'n'Load: sites post the links to 127.0.0.1:9666. The page script intercepts that
    // in the page itself (fetch, XHR, forms), the relay passes it to the background.
    { matches: pages, js: ['cnl-page.js'], run_at: 'document_start', all_frames: true, world: 'MAIN' },
    { matches: pages, js: ['cnl-relay.js'], run_at: 'document_start', all_frames: true },
  ],
  ...(browser === 'firefox' && {
    browser_specific_settings: {
      gecko: {
        id: 'haul@firsttris.github.io',
        // world: MAIN for content scripts
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['none'] },
      },
    },
  }),
});

for (const browser of ['chrome', 'firefox']) {
  const out = join(root, 'dist', browser);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // One build per script: Bun.build bundles the modules shared by several entry points whole
  // into each, while one at a time it leaves out what that script does not use.
  for (const name of ['background', 'popup', 'options', 'cnl-page', 'cnl-relay']) {
    const result = await Bun.build({
      entrypoints: [join(root, 'src', `${name}.ts`)],
      outdir: out,
      // The page script runs in the site's world: one self-contained script, no module.
      format: 'iife',
      // No syntax lowering, unlike esbuild's chrome111/firefox128 before: for this code esbuild's
      // output was the same as for esnext.
      target: 'browser',
      // The sources are modules and so strict; the IIFE has to say it itself.
      banner: '"use strict";',
    });
    if (!result.success) throw new AggregateError(result.logs, `extension/src/${name}.ts`);
    for (const log of result.logs) console.warn(log);
  }
  cpSync(join(root, 'static'), out, { recursive: true });
  cpSync(join(root, 'icons'), join(out, 'icons'), { recursive: true });
  cpSync(join(root, '_locales'), join(out, '_locales'), { recursive: true });
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest(browser), null, 2)}\n`);
  console.log(`extension/dist/${browser}`);
}
