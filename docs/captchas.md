# Captchas

Haul handles three kinds of captchas.

| Kind | Who solves it |
|---|---|
| Simple text captchas of XFileSharing sites | Haul reads them itself |
| Image captchas (XFileSharing `/captchas/…`) | You type the text in Haul's banner, no browser extension needed |
| reCaptcha, hCaptcha, Cloudflare Turnstile | You, in your browser, with the userscript |

## The userscript

reCaptcha, hCaptcha and Turnstile only work on the hoster's own page. Haul lets you solve them in your
browser on that page and takes the answer:

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).

   **Chrome, Edge, Brave and other Chromium browsers** run userscripts only after you allow it:
   open the extension's details (`chrome://extensions` → *Details*) and turn on
   **Allow user scripts**. In older versions (before Chrome 138) there is no such switch; turn on
   **Developer mode** at the top right of `chrome://extensions` instead. Without it the userscript
   is installed but never runs: **Solve** opens the full hoster page, and Haul gets no answer.
   Firefox needs nothing of this.
2. In Haul, open **Settings → Captchas** and install the userscript `haul-captcha.user.js` from there.
3. When a captcha is waiting, a banner appears at the top of Haul, and in the tab title. Turn on the
   browser notification in the same settings to be told when Haul is in the background.
4. **Solve** opens the hoster page. The userscript shows only the captcha there and sends the answer to
   Haul. The download continues by itself; you can close the tab.

A captcha waits 10 minutes for you. Without an answer, Haul tries again 30 minutes later.

## Security

The userscript only acts when Haul opens a page with a task in the `#…` part of the URL. That part is
never sent to the hoster. The task carries a one-time secret, so the answer only reaches the download
that asked for it.

The same mechanism solves captchas on login pages, for example ddownload's Turnstile, so you do not need
to enter the `xfss` cookie there.

## For plugin authors

```ts
const token = await ctx.captcha.solve({ kind: 'turnstile', siteKey, pageUrl });
const text = await ctx.captcha.solve({ kind: 'image', imageUrl, pageUrl });
```

`kind` is `recaptcha`, `hcaptcha`, `turnstile` or `image`. The XFileSharing base finds and solves
captchas in its forms by itself. See [Plugins](plugins.md).
