# Hosters

Every hoster is a plugin. Direct HTTP(S) links work without a plugin.

- [Supported hosters](#supported-hosters)
- [Accounts](#accounts)
- [Hoster notes](#hoster-notes)
- [Password-protected files](#password-protected-files)
- [Checksums](#checksums)
- [Waits and limits](#waits-and-limits)

## Supported hosters

| Hoster | Without account | With account | Folders |
|---|:---:|---|:---:|
| 1fichier | ✅ waits between downloads | API key, no waits | ✅ |
| Datanodes | ✅ Turnstile in the browser | account login | – |
| ddownload | – | premium login (or `xfss` cookie) | – |
| FileQ | ✅ text captcha | premium login | – |
| Filekeeper | ✅ reCaptcha in the browser | premium login | – |
| Gofile | ✅ guest token | API token | ✅ |
| Google Drive | ✅ public files | browser cookies: private files, fewer quota problems | ✅ |
| MEGA | ✅ free transfer quota | Pro account (no 2FA yet) | ✅ |
| Mediafire | ✅ | e-mail and password | ✅ |
| Send (send.now, send.cm, tusfiles, userscloud) | ✅ countdown, text captcha | premium login or API key | ✅ |

The plugins also recognise the other domains of these hosters:

| Hoster | Domains |
|---|---|
| 1fichier | 1fichier.com, alterupload.com, cjoint.net, desfichiers.com, desfichiers.net, dfichiers.com, dl4free.com, megadl.fr, mesfichiers.org, piecejointe.net, pjointe.com, tenvoi.com |
| ddownload | ddownload.com, ddl.to |
| Google Drive | drive.google.com, docs.google.com |
| MEGA | mega.nz, mega.co.nz |
| Mediafire | mediafire.com, mfi.re |
| Send | send.now, send.cm, sendit.cloud, tusfiles.com, tusfiles.net, userscloud.com, usersfiles.com, usercdn.com |

Folder links are resolved into their files when you add them, with sub-folders; the package gets the
folder's name. This happens in the background, so adding, even by Click'n'Load, never waits for it.

## Accounts

Add accounts under **Accounts & plugins**. Each plugin says there what it expects:

| Hoster | User | Password field |
|---|---|---|
| ddownload, Datanodes, FileQ, Filekeeper | user name | password, or the `xfss` cookie as `xfss=…` |
| Send | user name, or empty | password, `xfss=…`, or the API key with an empty user |
| 1fichier | – | API key from the 1fichier settings |
| Gofile | – | API token from your profile |
| Mediafire | e-mail | password |
| MEGA | e-mail | password (accounts with two-factor login are not supported yet) |
| Google Drive | – | cookies from the browser, see below |

Passwords are stored encrypted with `APP_SECRET`. The page shows the account type, expiry date and
remaining traffic where the hoster tells them. With several accounts for a hoster, Haul takes the one
with the most traffic left; accounts the hoster rejected are skipped.

**XFileSharing sites with a login captcha** (ddownload's login has Turnstile): solve it in the
browser with the [userscript](captchas.md), or log in once in your browser and enter its `xfss` cookie
as the password: `xfss=…`.

**Google Drive** accounts are added with the cookies of a browser that is logged in to
drive.google.com: export them with an extension such as
Cookie-Editor (JSON, `cookies.txt` or a `Cookie: …` line) and paste them into the password field. An
optional line `User-Agent: …` makes Haul use the same browser identity.

## Hoster notes

- **Google Drive**: public files and folders (with sub-folders and shortcuts), confirmation of large
  files, quota and rate limits with waits. Google documents are exported: in the format the title
  names (`Report.pdf`), otherwise like Drive's own download as Word, Excel or PowerPoint, otherwise
  PDF/ODF/text, as a last resort as ZIP.
- **MEGA**: the file arrives encrypted and is decrypted while it is saved (AES-CTR per segment, also
  when a download resumes). If the key is missing from the link, Haul asks for it like for a password.
  When the free transfer quota is used up, all MEGA downloads wait the time MEGA names.
- **Mediafire**: name and size come from the API when a link is added.
- **1fichier**: waits between downloads and for free slots are waited out without counting as failed
  attempts.
- **Gofile without account**: Haul keeps its requests few and respects the guest rate limit; when it
  is reached, all Gofile downloads wait.
- **ddownload**: web login with a premium account. ddownload has turned off downloads through its
  API, so API keys no longer work. It is tested against recorded pages, not yet against a real
  premium account.

## Password-protected files

A download password can be given when adding links (**Password** in the link grabber; folders pass it
on to their files). If it is missing or wrong, Haul asks in the banner at the top, the same place as
for captchas. The password is stored with the download and never sent back to the UI. After three
wrong passwords the download fails; **Cancel** ends it at once; unanswered, Haul asks again after 30
minutes.

The same password is also tried first when the archive is extracted, since it is usually the same.
The API takes `password`, or `downloadPassword` and `passwords` separately.

Supported for 1fichier, Gofile, Mediafire and the XFileSharing hosters (Send, ddownload, Datanodes,
FileQ, Filekeeper).

## Checksums

Where the hoster publishes a checksum, Haul verifies the file after the download: Google Drive (SHA-256/MD5), Gofile (MD5), Mediafire (MD5, SHA-1 or SHA-256), Send (SHA-256) and MEGA (the
MAC in the key). A match shows "verified" next to the file. A mismatch downloads the file once
more and then reports "checksum wrong". One check runs at a time; checks can be turned off under
**Settings → Verify the checksum** (on by default).

## Waits and limits

- A wait the hoster asks for (free limit, countdown) is waited out and does not count as a failed
  attempt.
- A limit for the whole hoster (IP limit, free slots taken) makes all its downloads wait, instead of
  each one running into it.
- Free downloads use one connection per file where hosters refuse more. Premium downloads use up to
  **Settings → Connections per file**.
- Other errors are retried with a growing pause, up to **Settings → Retries**.

Missing a hoster? Plugins are small TypeScript files, see [Plugins](plugins.md).
