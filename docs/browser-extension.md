# Browser extension

The Haul extension for Chrome and Firefox connects your browser to your Haul server:

- **Click'n'Load**: buttons on link sites that send the links to JDownloader
  (`127.0.0.1:9666`) send them to Haul instead. Nothing has to run on your computer.
- **Right-click → Send to Haul** on a link, on selected text (every link in it) or on the page.
- **Popup**: paste any text with links and send them, send the current page, open Haul.

The links land in the **link grabber** with the page they came from, unless you turn on
*Start downloads right away* in the extension's settings.

## Install

The extension is not in the Chrome Web Store or on addons.mozilla.org yet. Every
[release](https://github.com/firsttris/haul/releases) has `haul-extension-chrome.zip` and
`haul-extension-firefox.zip`; the build of the latest commit is attached to the
[Browser extension workflow](https://github.com/firsttris/haul/actions/workflows/extension.yml) runs.

**Chrome, Edge, Brave, Vivaldi**

1. Unzip `haul-extension-chrome.zip` into a folder you keep.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the folder.

**Firefox** (128 or later)

Firefox installs only signed add-ons for good. Until the extension is signed on
addons.mozilla.org:

- **Firefox Developer Edition, Nightly or ESR**: set `xpinstall.signatures.required` to `false` in
  `about:config`, then open `about:addons` → ⚙ → **Install Add-on From File…** and pick the zip.
- **Any Firefox, until the next restart**: `about:debugging#/runtime/this-firefox` →
  **Load Temporary Add-on…** → pick `manifest.json` from the unzipped folder.

**From source**: `pnpm install && pnpm build:extension` builds `extension/dist/chrome` and
`extension/dist/firefox`.

## Set up

1. In Haul, open **Settings → Click'n'Load from the desktop** and create an API token.
2. Open the extension's settings (the popup's *Settings* link, or right-click the toolbar icon →
   *Options*) and enter:
   - **Haul address**, as you open it in the browser, e.g. `http://server.local:8080`
   - **API token** from step 1
3. Click **Save** and allow what the browser asks for:
   - access to your Haul server, to send the links;
   - in Firefox, if not given on install, access to all websites, for Click'n'Load (Chrome grants
     it on install). With Click'n'Load turned off, the extension does not ask for it.

*Connected: 0 active, 0 queued* means everything is set. **Settings → Test Click'n'Load in this
browser** in Haul now says that the extension handles Click'n'Load.

## How Click'n'Load works here

A Click'n'Load button makes the page send the links to `http://127.0.0.1:9666/flash/add` or
`/flash/addcrypted2`, by a form, `fetch` or `XMLHttpRequest`. The extension takes these requests
over inside the page, before the browser sends them, and passes their form fields to Haul's
`/api/cnl/flash/…` with the API token, and the page gets the usual Click'n'Load answer.

Haul decrypts CNL2 as always, in its own QuickJS instance without host functions.

With Click'n'Load turned off in the extension's settings, pages reach `127.0.0.1:9666` as before,
so a local JDownloader or [`haul-cnl`](click-n-load.md#haul-cnl) still works.

## Troubleshooting

- **Nothing happens on a Click'n'Load button**: reload the page after installing or setting up the
  extension. The extension's badge shows ✓ or ! for a few seconds after each send.
- **!** on the badge, or an error in the popup: open the settings and click **Test connection**. It
  tells whether the address is wrong, Haul is unreachable or the token was replaced.
- **Firefox and Click'n'Load**: check `about:addons` → Haul → *Permissions* that
  *Access your data for all websites* is on.
- Haul logs each forwarded request as `Click'n'Load request … origin=chrome-extension://…`
  (or `moz-extension://`).
