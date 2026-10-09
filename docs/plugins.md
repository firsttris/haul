# Plugins

A plugin does one thing: **link in, direct URL plus headers out**. Everything that touches the file's
bytes (segments, resume, speed limit, checksums) is done by the Rust core. Plugins are TypeScript,
bundled to JavaScript and run in QuickJS inside the server, without Node, `fetch` or timers.

- [A minimal plugin](#a-minimal-plugin)
- [The plugin definition](#the-plugin-definition)
- [The context](#the-context)
- [Helpers](#helpers)
- [Errors](#errors)
- [XFileSharing sites](#xfilesharing-sites)
- [Messages in two languages](#messages-in-two-languages)
- [Building and installing](#building-and-installing)
- [Testing](#testing)
- [Testing on real hosters](#testing-on-real-hosters)
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

## The plugin definition

| Field | |
|---|---|
| `id`, `name`, `version` | `id` must be unique; a file in `/config/plugins` with the same `id` replaces the built-in plugin |
| `matches` | URL patterns; the first plugin with a matching pattern handles a link |
| `domains` | the hoster's domains, shown in the plugin list |
| `accountRequired` | without an account, links of this hoster are not even tried |
| `serial` | run calls without an account one at a time too, for hosters that rate-limit guests |
| `crawlWithAccount` | `crawl` gets the account, e.g. to list private folders |
| `account` | the account form: `userLabel`, `secretLabel`, `help`, and `secretMultiline` for a text area (exported cookies) |

| Function | Returns |
|---|---|
| `resolve(link, ctx)` (required) | `url`, and optionally `headers`, `cookies`, `name`, `size`, `maxConnections`, `hash`, and `decrypt: { cipher: 'aes-128-ctr', key, iv }` for files the hoster stores encrypted |
| `check(link, ctx)` | `online`, and optionally `name`, `size`, `hash`; runs when links are added and on **Check** |
| `crawl(link, ctx)` | `{ packageName?, files: [{ url, name?, size?, hash? }] }` for a folder link (see `plugins/gofile`); runs in the background after a link is added |
| `checkAccount(ctx)` | `valid`, and optionally `premium`, `trafficLeft` (bytes), `validUntil` (ms), `message`; shown under **Accounts & plugins** |

A `hash` is `{ type: 'md5' | 'sha1' | 'sha256' | 'mega', value }`. The one from `resolve` wins over the
one from `crawl` or `check`.

## The context

| | |
|---|---|
| `ctx.http.get/post/request` | HTTP with one cookie jar per account; the login survives between calls and restarts. Options: `headers`, `followRedirects`, `form`, `json`, `body`, `timeoutMs`, `page` (read the answer as a page even if its headers say it is a file). |
| `ctx.cookies.get/set` | the jar directly |
| `ctx.account.get()` | `{ id, user, secret }` or `null` |
| `ctx.password.get({ wrong? })` | the download password; asks the user if none is stored. `wrong: true` forgets the rejected one and asks again. `withPassword(ctx, name, attempt)` gives up to three attempts. |
| `ctx.password.saved()`, `forget()` | the stored password without asking, or `null`; forget a rejected one without asking |
| `ctx.captcha.solve(...)` | see [Captchas](captchas.md) |
| `ctx.wait(seconds)` | a countdown |
| `ctx.hash.sha256(text)` | hex SHA-256, computed in Rust (QuickJS has no crypto) |
| `ctx.crypto.aesDecrypt({ mode, key, iv?, data })` | AES-128 ECB or CBC without padding, hex in and out |
| `ctx.crypto.run(op, args)` | heavier crypto in Rust, async: `pbkdf2Sha512`, `aesEncrypt`, `modPow`, `megaPrepareKey`, `megaUserHashV1`, `megaHashcash` |
| `ctx.pluginId` | the plugin's own id |
| `ctx.log` | `info`, `warn`, `error`, `debug` |

## Helpers

`@haul/plugin-sdk` also exports small helpers, because QuickJS has no DOM, `URL`, `atob` or crypto:

| Helper | |
|---|---|
| `match(text, ...patterns)` | first capture group of the first matching pattern, HTML entities decoded and trimmed |
| `parseForms(html)` | every `<form>` with its inputs, selects and text areas |
| `decodeHtml(s)`, `resolveUrl(base, href)` | HTML entities; relative links |
| `parseSize(text)` | `"1.5 GB"`, `"700,2 MB"` to bytes |
| `base64Decode(s)`, `sha1Hex(text)` | Base64 (also URL-safe) to text; hex SHA-1 |
| `cookiesFrom(res)` | the cookies a response set |
| `findCaptcha(html)`, `recaptchaKeyInCode(html)`, `CAPTCHA_FIELD` | find a reCaptcha, hCaptcha or Turnstile widget and its site key; the form field for the token |
| `withPassword(ctx, name, attempt)`, `WRONG_PASSWORD` | up to three password attempts; `attempt` returns `WRONG_PASSWORD` when the hoster rejects one |
| `memo.get(ctx, site, key)`, `memo.set(ctx, site, key, value, maxAgeSeconds?)` | small values kept between calls, stored in the account's cookie jar |
| `spaceRequests(ctx, site, ms)` | keeps at least `ms` between requests to a site, also across calls |
| `parseCookieExport(text)`, `importCookies(ctx, cookies, domain)` | read cookies exported from a browser (JSON, `cookies.txt` or a `Cookie:` line) into the jar |
| `bilingual(de, en)`, `pickLang(message, lang)` | messages in two languages, see below |

## Errors

| Error | Meaning |
|---|---|
| `OfflineError` | file gone; no retry |
| `TemporaryError(message, seconds?)` | try again later; with seconds, exactly then and not counted as a failure |
| `HosterLimitError(message, seconds)` | the whole hoster is limited (IP limit, free slots); all its downloads wait |
| `AccountError` | the account is wrong or expired |
| `PluginError('fatal', message)` | give up |

## XFileSharing sites

Many hosters run XFileSharing Pro. `createXfsPlugin` from `@haul/plugin-sdk/xfs` handles them: login, premium and free downloads (forms, countdown, captchas), errors and
waits. ddownload is a few lines of configuration. Where a site differs, `freeHooks` (forms, countdown,
direct link) and `headers` adapt it; see `plugins/datanodes` for a site with its own quirks.

The most used options of `XfsConfig`:

| Option | |
|---|---|
| `domains`, `fileIdLength` | main domain first; length of the file id in URLs (default 12) |
| `free`, `freeMaxConnections` | free downloads without an account; their connections per file (default 1) |
| `apiBase`, `userApiKeys` | the site's JSON API, and whether accounts may be an API key instead of a login |
| `maxConnections`, `downloadHosts` | connection limit; extra CDN hosts that serve the files |
| `offlinePatterns`, `namePatterns`, `sizePatterns`, `sha256Pattern`, `directLinkPatterns` | where the site differs from the XFS defaults |
| `premiumPattern`, `validUntilPatterns`, `trafficLeft` | read the account page |
| `checkErrors`, `headers`, `freeHooks` | site-specific errors, extra headers, a different free flow |

`@haul/plugin-sdk/xfs` also exports the pieces on their own: `parseWait`, `countdown`,
`captchaImage`, `plainTextCaptcha`, `parseDate` and `isApiAccount`.

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
"Custom file". If the built-in one is newer, the UI warns you, so you get updates again after deleting your
copy.

## Testing

Plugins are tested without a server, with the fake context from `@haul/plugin-sdk/testing`.
`fakeCtx(routes, account?)` answers each `'METHOD url'` with a fixed response or a handler function:

```ts
const ctx = fakeCtx({ 'GET https://example.com/f/abc': { body: page } });
expect(await plugin.resolve(link, ctx)).toMatchObject({ url: cdn });
```

See the tests next to every plugin, for example `plugins/ddownload/test`.

## Testing on real hosters

The tests above show that a plugin understands the pages it was written for, not that the hoster
still sends them. `haul probe` tries the plugins on the real hosters, the way a download runs:
for each case it crawls the link (folders), checks it, resolves it and downloads the file, and
compares names, sizes and checksums with what you know about the file.

Use test files of your own, a few MB of random data, uploaded to every hoster; a folder with two of
them for hosters with folders. The cases are a JSON object, case name → case:

```json
{
  "ddownload": { "url": "https://ddownload.com/…/probe.bin", "name": "probe.bin", "size": 1048576 },
  "gofile-folder": { "url": "https://gofile.io/d/…", "files": 2, "name": "probe.bin", "md5": "…" },
  "1fichier-premium": { "url": "https://1fichier.com/?…", "account": { "secret": "API key" } }
}
```

| Field | |
|---|---|
| `url` | the link, as a user would add it |
| `name`, `size` | the file's name and size in bytes; every name and size the plugin reports must match |
| `md5`, `sha256` | checksum of the downloaded file |
| `files` | folder links: how many files `crawl` must find; `name` picks the file to download, else the first |
| `password` | of a protected file or folder |
| `account` | `{ "user", "secret" }` like in the UI; without one, a plugin that needs an account is only checked |
| `maxBytes` | download at most this much (default 64 MiB); a larger file is checked up to there |

```bash
pnpm build:plugins && cargo build -p haul
./target/debug/haul probe cases.json           # or the JSON in $HAUL_PROBE_CASES
./target/debug/haul probe --only ddownload cases.json
```

Each case ends with one status:

| Status | Meaning |
|---|---|
| `ok` | checked, resolved and downloaded as expected |
| `checked` | only the online check ran: the plugin needs an account and the case has none |
| `captcha` | the plugin got as far as a captcha, which needs a person |
| `unavailable` | the hoster was busy, limited or unreachable |
| `account` | the account was rejected or is out of traffic |
| `offline` | the hoster says the test file is gone: upload it again (or the plugin misreads the page) |
| `broken` | the plugin failed or returned something wrong |

The exit code is 1 if a case is `broken`, `offline` or `account`. `probe-out/` gets `report.json`,
`summary.md` and, for failed cases, the pages the hoster sent (as in
[Debugging a hoster](#debugging-a-hoster)) and the debug log. The console and the report name cases,
never links: URLs in messages are cut down to their host. Case names are public (summary, issue
titles); the log and the pages do contain links.

The [Hoster probe workflow](https://github.com/firsttris/haul/blob/main/.github/workflows/hoster-probe.yml)
runs every night and on pull requests that change plugins. It reads the cases from the secret
`HAUL_PROBE_CASES`; with `HAUL_PROBE_ZIP_PASSWORD` set it keeps the log and pages as an encrypted
`probe-pages` artifact. The nightly run opens an issue (label `hoster-probe`) when a case breaks,
comments when what is wrong changes, and closes it when the case works again. The issue says since
when the case fails and when it last worked. A hoster that is only `unavailable` gets an issue after
three nights in a row. Each run also downloads the test files, which keeps hosters from deleting
them as unused.

## Debugging a hoster

Hosters change their pages. With `RUST_LOG=haul=debug`, Haul keeps the pages a plugin received and
saves them next to the download in the tmp folder when it fails:

- `<id>.plugin-<n>.html`: the last pages of a failed plugin call, each starting with
  `<!-- METHOD status URL -->`;
- `<id>.page.html`: the page a direct link returned instead of the file.

The log says which files were written. Compare them with what your browser gets (developer tools,
Network tab, *Copy as cURL*) and adapt the plugin; a plugin in `/config/plugins/` needs no new image.
