---
name: hoster-plugin
description: Write, fix or debug a Haul hoster plugin (plugins/<name>, TypeScript run in QuickJS). Use when asked to add support for a new file hoster, to repair a plugin after a hoster changed its pages, to handle a new error, captcha, account type or folder link, or to build a custom plugin for /config/plugins.
---

# Hoster plugins for Haul

A plugin turns a link into a direct URL plus headers. Everything that touches the file's bytes
(segments, resume, speed limit, checksums) is the Rust core's job. The reference for the API is
[`docs/plugins.md`](../../../docs/plugins.md): read it first, every time, it is the source of truth
for the definition, the context (`ctx`), the helpers, the errors and the XFS options. The SDK
itself is `packages/plugin-sdk/src/{index,xfs,testing}.ts`.

## 1. Understand the hoster before writing code

- Look at how the existing plugins do the same thing. Pick the closest one:
  - XFileSharing Pro site (URLs like `/<12 chars>/name`, forms `op=download1/download2`,
    `?op=my_account`): `createXfsPlugin` from `@haul/plugin-sdk/xfs`. Few lines:
    `plugins/ddownload`; with quirks (`freeHooks`, `headers`): `plugins/datanodes`, `plugins/send`.
  - JSON API, guest tokens, folders: `plugins/gofile`, `plugins/1fichier`.
  - Plain pages with a download button: `plugins/mediafire`.
  - Cookies exported from a browser as account: `plugins/gdrive`.
  - Encrypted files and heavy crypto: `plugins/mega`.
- Use JDownloader's and pyLoad's plugin for that hoster as references (as the existing plugins
  do): they know the URL patterns, the error texts, connection limits and waits. Name them, with
  version or date, in the comment at the top of `src/index.ts`, and explain the hoster's flow
  there (see the header of `plugins/gofile/src/index.ts`).
- If you can reach the hoster, fetch real pages (file page, offline page, folder, login) and keep
  trimmed copies for the tests. Never commit real account data, cookies or private links.

## 2. Files

A new plugin `plugins/<name>/` (lower case, the folder name becomes `plugins/dist/<name>.js`;
the build and the server pick it up on their own, no registration elsewhere):

`package.json`
```json
{
  "name": "@haul/plugin-<name>",
  "version": "0.1.0",
  "private": true,
  "license": "GPL-3.0-or-later",
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "@haul/plugin-sdk": "workspace:*"
  }
}
```

`tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022"], "types": [] },
  "include": ["src"]
}
```

`src/index.ts` with `export default definePlugin({ ... })`, and `test/<name>.test.ts`.
Run `pnpm install` once afterwards so the workspace links `@haul/plugin-sdk`.

## 3. Rules of the runtime (QuickJS, not Node)

- No `fetch`, `URL`, `URLSearchParams`, `atob`/`btoa`, `setTimeout`, `crypto`, DOM, Node modules
  or npm packages. Use `ctx.http`, `ctx.wait`, `ctx.hash`, `ctx.crypto` and the SDK helpers
  (`match`, `parseForms`, `resolveUrl`, `decodeHtml`, `parseSize`, `base64Decode`, `sha1Hex`,
  `cookiesFrom`, `memo`, `spaceRequests`, ...). `lib: ["ES2022"]` with `types: []` makes the
  typecheck reject most of the forbidden globals.
- Only `@haul/plugin-sdk` may be imported; esbuild bundles it into one IIFE.
- State between calls lives in the account's cookie jar (`ctx.cookies`, `memo`), never in
  module variables you rely on across calls.
- Throw the SDK errors, so the queue does the right thing: `OfflineError` (gone, no retry),
  `TemporaryError(msg, seconds?)`, `HosterLimitError(msg, seconds)` (whole hoster waits),
  `AccountError`, `PluginError('fatal', msg)`. Recognise data-centre blocks and Cloudflare pages
  instead of failing with a parse error.
- Every message a user sees is bilingual: `{ de: '…', en: '…' }`, or `bilingual(de, en)` where
  it must be a string. Account form labels and help too. German and English both carefully
  written, not machine-literal.
- Never log or put into messages secrets, tokens or full links of private files.
- Raise `version` on every change of a plugin: a copy in `/config/plugins` with a lower version
  than the built-in one triggers the "built-in is newer" warning.
- Set `maxConnections` to what the hoster allows (JD's `getMaxChunks`), `serial` if guests are
  rate-limited, and return `name`, `size` and `hash` wherever the hoster publishes them.
- Keep the code like the existing plugins: short, comments that explain the hoster's behaviour
  and where it was learned, no dead fallbacks.

## 4. Tests

Tests run without a server against `fakeCtx` from `@haul/plugin-sdk/testing`:
`fakeCtx({ 'GET https://…': { body, status?, headers? } | (req) => response }, account?)`.
Cover at least: `matches` (every domain, and a foreign URL that must not match), `check` of an
online and an offline file, `resolve` (free and, if there is one, account), the hoster's
waits/limits/captcha path, `checkAccount`, `crawl` for folders, and password handling if the
hoster has it. Assert on the forms and headers the plugin sends, not only on the result.
`plugins/ddownload/test/ddownload.test.ts` is a good template.

## 5. Checks before you are done

```bash
pnpm vitest run plugins/<name>  # the plugin's tests (pnpm test runs everything)
pnpm typecheck
pnpm build:plugins              # must bundle without warnings → plugins/dist/<name>.js
cargo test --workspace          # if the Rust side or the SDK prelude was touched
```

Against the real hoster, if you have a test link (keep it out of the repository):

```bash
cargo build -p haul
./target/debug/haul probe --secrets links.json --only <case> .github/hoster-probe.json
```

`links.json` is `{"PROBE_<CASE>": "https://…"}`. Statuses and fields: "Testing on real hosters"
in `docs/plugins.md`.

## 6. Docs for a new or changed hoster

- `README.md`: the *Supported hosters* table.
- `docs/hosters.md`: *Supported hosters*, the domains table, and *Hoster notes* if the hoster has
  quirks users must know (cookies, waits, captchas).
- `.github/hoster-probe.json`: an entry only if the case expects something other than `*`
  (e.g. `{"files": 2}` for a folder). Tell the user which `PROBE_<CASE>` secret to add.

## 7. Repairing a plugin after the hoster changed

1. Get the pages the plugin saw: with `RUST_LOG=haul=debug` a failed call writes
   `<id>.plugin-<n>.html` (each starts with `<!-- METHOD status URL -->`) into the tmp download
   folder; a direct link that returned a page writes `<id>.page.html`. Ask the user for them, or
   for a *Copy as cURL* / saved page from the browser.
2. Add the new page as a test case first and watch it fail, then fix. Keep old patterns as long
   as the old layout may still be served (ddownload keeps several `namePatterns`).
3. Raise `version`, run the checks above.

## 8. A plugin only for one server

For a user who wants a plugin without contributing it: same files and tests, then
`pnpm build:plugins`, copy `plugins/dist/<name>.js` to the server's `/config/plugins/`, and click
**Reload** under **Accounts & plugins**. No new image is needed. A plugin there with the `id` of a
built-in one replaces it.
