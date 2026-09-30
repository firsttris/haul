# Plugins

A plugin does one thing: **link in, direct URL plus headers out**. Everything that touches the file's
bytes (segments, resume, speed limit, checksums) is done by the Rust core. Plugins are TypeScript,
bundled to JavaScript and run in QuickJS inside the server, without Node, `fetch` or timers.

- [A minimal plugin](#a-minimal-plugin)
- [The context](#the-context)
- [Errors](#errors)
- [XFileSharing sites](#xfilesharing-sites)
- [Messages in two languages](#messages-in-two-languages)
- [Building and installing](#building-and-installing)
- [Testing](#testing)
- [Debugging a hoster](#debugging-a-hoster)

## A minimal plugin

```ts
import { definePlugin, OfflineError } from '@haul/plugin-sdk';

export default definePlugin({
  id: 'example',
  name: 'Example',
  version: 1,
  matches: [/https?:\/\/example\.com\/f\/(\w+)/i],
  accountRequired: false,

  async check(link, ctx) {
    const res = await ctx.http.get(link);
    return { online: res.status !== 404 };
  },

  async resolve(link, ctx) {
    const res = await ctx.http.get(link, { followRedirects: false });
    if (res.status === 404) throw new OfflineError();
    return { url: res.header('location')!, headers: { Referer: link } };
  },
});
```

Optional:

- `crawl(link, ctx)` turns a folder link into its files, with name and size (see `plugins/gofile`).
  It runs in the background after a link is added.
- `checkAccount(ctx)` logs in and returns the account's state (`valid`, `premium`, `trafficLeft`,
  `validUntil`), shown under **Accounts & plugins**.
- `resolve` may return `name`, `size`, `maxConnections` and a `hash`
  (`{ type: 'md5' | 'sha1' | 'sha256' | 'mega', value }`) for the checksum check.

## The context

| | |
|---|---|
| `ctx.http.get/post/request` | HTTP with one cookie jar per account; the login survives between calls and restarts. Options: `headers`, `followRedirects`, `form`, `json`, `body`, `timeoutMs`, `page` (read the answer as a page even if its headers say it is a file). |
| `ctx.cookies.get/set` | the jar directly |
| `ctx.account.get()` | `{ id, user, secret }` or `null` |
| `ctx.password.get()` | the download password; asks the user if none is stored. `withPassword(ctx, name, attempt)` wraps JD's three attempts. |
| `ctx.captcha.solve(...)` | see [Captchas](captchas.md) |
| `ctx.wait(seconds)` | a countdown |
| `ctx.hash.sha256`, `ctx.crypto.*` | hashing and AES (for MEGA) |
| `ctx.log` | `info`, `warn`, `error`, `debug` |

## Errors

| Error | Meaning |
|---|---|
| `OfflineError` | file gone; no retry |
| `TemporaryError(message, seconds?)` | try again later; with seconds, exactly then and not counted as a failure |
| `HosterLimitError(message, seconds)` | the whole hoster is limited (IP limit, free slots); all its downloads wait |
| `AccountError` | the account is wrong or expired |
| `PluginError('fatal', message)` | give up |

## XFileSharing sites

Many hosters run XFileSharing Pro. `createXfsPlugin` from `@haul/plugin-sdk/xfs` does what JD's
`XFileSharingProBasic` does: login, premium and free downloads (forms, countdown, captchas), errors and
waits. ddownload is a few lines of configuration. Where a site differs, `freeHooks` (forms, countdown,
direct link) and `headers` adapt it; see `plugins/datanodes` for a site with its own quirks.

## Messages in two languages

The UI is in German and English, including the messages of plugins:

```ts
throw new OfflineError({ de: 'Datei gelöscht', en: 'File deleted' });
```

A plain string is used for both. Where a message has to be one string, `bilingual(de, en)` packs both.
Texts for the account form (`account.userLabel`, `secretLabel`, `help`) take a string or `{ de, en }`.

## Building and installing

```bash
pnpm build:plugins        # → plugins/dist/<name>.js
```

Put your own or updated plugins into `/config/plugins/` and click **Reload** under
**Accounts & plugins**. A plugin there replaces the built-in one with the same `id` and is shown as
"own file". If the built-in one is newer, the UI warns you, so you get updates again after deleting your
copy.

## Testing

Plugins are tested without a server, with the fake context from `@haul/plugin-sdk/testing`:

```ts
const ctx = fakeCtx({ 'GET https://example.com/f/abc': { body: page } });
expect(await plugin.resolve(link, ctx)).toMatchObject({ url: cdn });
```

See the tests next to every plugin, for example `plugins/ddownload/test`.

## Debugging a hoster

Hosters change their pages. With `RUST_LOG=haul=debug`, Haul keeps the pages a plugin received and
saves them next to the download in the tmp folder when it fails:

- `<id>.plugin-<n>.html`: the last pages of a failed plugin call, each starting with
  `<!-- METHOD status URL -->`;
- `<id>.page.html`: the page a direct link returned instead of the file.

The log says which files were written. Compare them with what your browser gets (developer tools,
Network tab, *Copy as cURL*) and adapt the plugin; a plugin in `/config/plugins/` needs no new image.
