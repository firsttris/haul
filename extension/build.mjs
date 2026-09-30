// Builds the extension for Chrome and Firefox into dist/chrome and dist/firefox from one
// source: the scripts are bundled with esbuild, the manifest differs only where the browsers do
// (service worker vs. event page, Firefox's add-on id).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pages = ['http://*/*', 'https://*/*'];

const manifest = (browser) => ({
  manifest_version: 3,
  name: '__MSG_extName__',
  description: '__MSG_extDescription__',
  version: pkg.version,
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
  await build({
    entryPoints: ['background', 'popup', 'options', 'cnl-page', 'cnl-relay'].map((n) => join(root, 'src', `${n}.ts`)),
    outdir: out,
    bundle: true,
    // The page script runs in the site's world: one self-contained script, no module.
    format: 'iife',
    target: browser === 'firefox' ? 'firefox128' : 'chrome111',
    legalComments: 'none',
    logLevel: 'warning',
  });
  cpSync(join(root, 'static'), out, { recursive: true });
  cpSync(join(root, 'icons'), join(out, 'icons'), { recursive: true });
  cpSync(join(root, '_locales'), join(out, '_locales'), { recursive: true });
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest(browser), null, 2)}\n`);
  console.log(`extension/dist/${browser}`);
}
