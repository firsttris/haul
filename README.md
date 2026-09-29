# Haul

Headless-Download-Server mit Web-UI für den Heimserver. Ein Binary in einem Docker-Container:
Links einfügen oder per Click'n'Load schicken, der Server lädt, der Browser zeigt den Fortschritt live.

**v1 kann:**

- direkte HTTP-Links
- ddownload mit Premium-Account (Web-Login oder API-Key)
- Accounts wie bei JDownloader (unter *Accounts & Plugins*):

  | Hoster | Anmeldung | Premium |
  |---|---|---|
  | ddownload, Datanodes | Benutzer/Passwort oder xfss-Cookie | Premium-Weg der Seite |
  | Send | Benutzer/Passwort, xfss-Cookie oder API-Key (Benutzer leer) | API nur mit Direktlink-Traffic |
  | 1fichier | API-Key aus den 1fichier-Einstellungen | API, ohne Wartezeiten |
  | Gofile | API-Token aus dem Profil | Links mit dem Account-Token |
  | Mediafire | E-Mail und Passwort | Direktlink über die API |
  | MEGA | E-Mail und Passwort (ohne Zwei-Faktor) | Transfer-Kontingent des Pro-Accounts |

  Google Drive kennt kein Premium; ein Google-Login (nur per Browser-Cookies) fehlt noch.
- Gofile ohne Account: Ordner-Links werden beim Hinzufügen in ihre Dateien aufgelöst (mit
  Unterordnern, Paketname = Ordnername), Download mit Gast-Token; der Direktlink aus dem Ordner wird
  wiederverwendet und API-Anfragen laufen nacheinander (Rate-Limit für Gäste)
- Send (send.now, früher send.cm, tusfiles, userscloud) ohne Account über den XFS-Free-Weg wie bei
  JDownloader (Countdown, Text-Captcha), mit Account über den Premium-Weg; Ordner-Links (`/s/…`)
  werden in ihre Dateien aufgelöst, über alle Seiten
- 1fichier (und Alias-Domains) ohne Account wie bei JDownloader: Name/Größe über `check_links.pl`,
  Ordner über `?json=1`, Wartezeiten zwischen Downloads und bei fehlenden freien Slots werden
  abgewartet, ohne als Fehlversuch zu zählen
- Google Drive: öffentliche Dateien und Ordner (mit Unterordnern und Verknüpfungen) ohne Account
  wie bei JDownloader (schneller Link-Check, Bestätigung bei großen Dateien, Kontingent- und
  Rate-Limit mit Wartezeit); Google-Dokumente noch nicht
- Datanodes ohne Account (XFS mit JDs Datanodes-Anpassungen); ein reCaptcha löst du im Browser
  (siehe [Captchas](#captchas))
- MEGA (mega.nz) ohne Account wie bei JDownloader und pyLoad: Datei- und Ordner-Links (auch
  Unterordner), Name über die MEGA-API; die Datei kommt verschlüsselt und wird beim Laden
  entschlüsselt (AES-CTR, pro Segment, auch beim Fortsetzen). Fehlt der Schlüssel im Link, fragt
  Haul danach wie nach einem Download-Passwort. Ist das freie Transfer-Kontingent erschöpft,
  warten alle MEGA-Downloads die von MEGA genannte Zeit ab
- Mediafire ohne Account: Datei-, Ordner- (mit Unterordnern) und Direktlinks; Name und Größe über
  die Mediafire-API schon beim Hinzufügen; Mediafires Checkbox-„Captcha“ wird automatisch bestätigt,
  beim IP-Limit wird wie bei JDownloader ein anderer User-Agent probiert
- Queue mit N parallelen Downloads, segmentiertes Laden über Range-Requests, `.part`-Dateien,
  Resume nach Neustart, Retry mit Backoff, globales Bandbreitenlimit
- Linksammler mit Online-Check, Paketname, Zielordner, Download-Passwort und Archiv-Passwörtern;
  jede Datei hat ein Häkchen (anfangs alle an, Shift-Klick für Bereiche), gestartet werden nur die
  angehakten, der Rest bleibt im Linksammler. Teilweise angehakte mehrteilige Archive meldet Haul
- passwortgeschützte Dateien und Ordner (1fichier, Gofile, Mediafire, XFS-Hoster wie Send,
  ddownload, Datanodes): Passwort beim Hinzufügen angeben oder eintippen, wenn Haul danach fragt
- Click'n'Load (CNL1 und CNL2) über `haul-cnl` auf dem Desktop
- automatisches Entpacken fertiger Pakete mit `7z`/`unrar`, mit Fortschritt in Prozent
- Ansicht **Fertig**: der Fertig-Ordner wie auf der Platte, mit Paketzustand (entpackt, Archive übrig,
  Fehler, nicht von Haul); Auswahl per Checkbox, dann Entpacken (ein beliebiger Teil entpackt den ganzen
  Satz, in denselben Ordner), Verschieben in andere Ordner, neuer Ordner, Archive löschen, Löschen

- Weboberfläche auf Deutsch und Englisch (Browsersprache, umschaltbar unten in der Seitenleiste
  und unter *Einstellungen*), auch die Meldungen von Server und Hoster-Plugins

**Bewusst nicht in v1:** DLC-Container, Multi-User.

## Schnellstart

```yaml
# docker-compose.yml
services:
  downloader:
    image: ghcr.io/firsttris/haul:latest
    restart: unless-stopped
    ports: ["8080:8080", "127.0.0.1:9666:9666"]
    volumes:
      - ./config:/config
      - /mnt/cache/downloads/tmp:/downloads/tmp
      - /mnt/disk1/downloads:/downloads/done
    environment:
      - APP_SECRET=...   # openssl rand -hex 32
```

```sh
docker compose up -d
```

Dann `http://server:8080` öffnen und beim ersten Aufruf den Benutzer anlegen (oder vorher
`HAUL_USER`/`HAUL_PASSWORD` setzen). Unter **Accounts & Plugins** den ddownload-Account eintragen.

### Umgebungsvariablen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `APP_SECRET` | – (Pflicht) | Schlüssel für die verschlüsselten Account-Passwörter. Nicht ändern, sonst sind gespeicherte Accounts unlesbar. |
| `HAUL_CONFIG_DIR` | `/config` | SQLite-Datenbank (`haul.db`) und eigene Plugins (`plugins/`) |
| `HAUL_TMP_DIR` | `/downloads/tmp` | laufende Downloads (`<id>.part`) |
| `HAUL_DONE_DIR` | `/downloads/done` | fertige Dateien, ein Unterordner pro Paket |
| `HAUL_LISTEN` | `0.0.0.0:8080` | Web-UI und API |
| `HAUL_CNL_LISTEN` | `127.0.0.1:9666` (im Image `0.0.0.0:9666`) | Click'n'Load; `off` schaltet es ab |
| `HAUL_BUILTIN_PLUGINS` | im Image `/app/plugins` | mitgelieferte Plugins |
| `HAUL_USER`, `HAUL_PASSWORD` | – | legt den Login beim ersten Start an |
| `HAUL_USER_AGENT` | Desktop-Browser | User-Agent gegenüber Hostern |
| `HAUL_7Z`, `HAUL_UNRAR` | `7z`, `unrar` | Programme zum Entpacken |
| `RUST_LOG` | `info` | Log-Level |

## Captchas

reCaptcha, hCaptcha und Turnstile gelten nur auf der Seite des Hosters. Haul löst sie deshalb wie
JDownloaders Browser-Solver in deinem Browser:

1. Tampermonkey oder Violentmonkey installieren, dann unter *Einstellungen → Captchas* das
   Userscript `haul-captcha.user.js` installieren.
2. Wartet ein Captcha, erscheint oben in Haul ein Hinweis (auch im Tab-Titel, auf Wunsch als
   Browser-Benachrichtigung). *Lösen* öffnet die Hoster-Seite; das Userscript zeigt dort nur das
   Captcha und schickt die Lösung an Haul. Der Download läuft danach von selbst weiter.
3. Ein Captcha wartet 10 Minuten; danach versucht Haul es nach 30 Minuten erneut.

Das Userscript wird nur aktiv, wenn Haul die Seite mit einer Aufgabe im `#…`-Teil der URL öffnet
(der geht nie an den Hoster), und meldet sich mit einem Einmal-Geheimnis der Aufgabe. So lösen
auch Web-Logins mit Captcha (ddownload: Turnstile) ohne den Umweg über das xfss-Cookie.
Plugins fragen mit `await ctx.captcha.solve({ kind, siteKey, pageUrl })`; einfache Text-Captchas
löst die XFS-Basis selbst. Bild-Captchas (XFS `/captchas/…`, JDs „Standard captcha“) zeigt Haul
direkt im Hinweis, ohne Userscript: das Bild lädt der Server mit den Cookies des Plugins, du tippst
den Text ab (`ctx.captcha.solve({ kind: 'image', imageUrl, pageUrl })`).

## Prüfsummen

Wo der Hoster eine Prüfsumme veröffentlicht, rechnet Haul sie nach dem Download nach (wie
JDownloaders „CRC OK“): Google Drive (Ordner: SHA-256/MD5), Gofile (MD5), Mediafire (SHA-256),
Send (SHA-256 auf der Dateiseite) und MEGA (die MAC im Schlüssel). Passt sie, steht neben der
Datei „✓ geprüft“; passt sie nicht, lädt Haul die Datei einmal komplett neu und meldet danach
„Prüfsumme falsch“. Plugins geben sie als `hash: { type: 'md5' | 'sha1' | 'sha256' | 'mega', value }`
bei `crawl`, `check` oder `resolve` mit. Archive prüft zusätzlich das Entpacken selbst.
Wie bei JDownloader läuft höchstens eine Prüfung gleichzeitig, weitere warten (`MaxConcurrentHashChecks`);
abschalten lässt sie sich unter *Einstellungen → Downloads* (`HashCheckEnabled`, standardmäßig an).

## Passwortgeschützte Dateien

Wie bei JDownloader: Ein Download-Passwort kann schon beim Hinzufügen im Linksammler stehen
(*Download-Passwort*, gilt für alle Links des Pakets; Ordner geben es an ihre Dateien weiter).
Fehlt es oder ist es falsch, fragt Haul oben im selben Hinweis wie bei Captchas nach; das
eingegebene Passwort bleibt beim Download gespeichert und wird nicht mehr an die UI geschickt.
Nach drei falschen Passwörtern schlägt der Download fehl, *Abbrechen* beendet ihn sofort; unbeantwortet
fragt Haul nach 30 Minuten erneut. Archiv-Passwörter zum Entpacken sind davon getrennt.

## Passwortgeschützte Archive

Wie JDownloaders Entpacker probiert Haul bei einem geschützten Archiv der Reihe nach: kein
Passwort, die Archiv-Passwörter des Pakets (Linksammler), den Archivnamen und die Liste unter
*Einstellungen → Archiv-Passwörter*. Passt keines, fragt Haul oben im Hinweis nach (abschaltbar:
*Beim Entpacken nach dem Passwort fragen, wenn keines passt*); nach einer falschen Eingabe fragt es erneut, bis zu
dreimal. Das Passwort, das ein Archiv geöffnet hat, steht danach ganz oben in der Liste und wird so
beim nächsten Archiv zuerst probiert.

## Click'n'Load

Die Webseite schickt die Links an `127.0.0.1:9666` **des Rechners mit dem Browser**. Weil Haul auf
dem Server läuft, muss dort etwas lauschen und weiterleiten:

- **Zum Testen:** `ssh -N -L 9666:localhost:9666 server.local`
- **Dauerhaft:** `haul-cnl`, ein kleines Rust-Binary. In der Web-UI unter *Einstellungen* ein
  API-Token erstellen, dann:

  ```sh
  cargo install --path crates/haul-cnl   # oder das Release-Binary nach ~/.local/bin
  haul-cnl --server http://server.local:8080 --token <TOKEN>
  ```

  Als systemd-User-Service siehe [`crates/haul-cnl/haul-cnl.service`](crates/haul-cnl/haul-cnl.service).

Empfangene Links landen im Linksammler, mit der Quellseite, und starten nie automatisch. Das
`jk`-Snippet von CNL2 läuft in einer eigenen QuickJS-Instanz ohne Host-Funktionen, mit Speicher-
und Zeitlimit. Port 9666 immer nur an `127.0.0.1` binden.

**Funktioniert der Klick nicht?**

1. Unter *Einstellungen* auf *Click'n'Load im Browser testen* klicken. Die Meldung sagt, ob auf
   `127.0.0.1:9666` des Browser-Rechners Haul oder `haul-cnl` antwortet.
2. Chrome fragt bei manchen Seiten nach Zugriff aufs lokale Netzwerk; das erlauben.
   **Brave** blockiert den Zugriff von Webseiten auf `localhost` standardmäßig („Localhost-Zugriff“).
   Auf der Seite im Adressleisten-Hinweis erlauben oder unter `brave://settings/content/localhostAccess`
   die Seite freigeben. Der Test-Button in Haul greift nicht, weil Haul selbst lokal läuft.
3. Im Log von Haul bzw. `haul-cnl` steht jede Anfrage (`Click'n'Load request …`). Steht dort
   nichts, erreicht der Browser den Port nicht.
4. Die Links landen im **Linksammler**, nicht direkt in den Downloads.

## Architektur

```
Browser ──HTTP/SSE──▶ axum ──▶ Queue/Engine ──▶ Plugin (QuickJS) ──▶ Direkt-URL
                         │           │
                         │           └──▶ Download-Engine (reqwest, Range-Segmente) ──▶ /downloads/tmp ──▶ /downloads/done
                         └──▶ SQLite (/config/haul.db)
Desktop: Webseite ──▶ 127.0.0.1:9666 (haul-cnl) ──Bearer-Token──▶ /api/cnl/flash/*
```

Die Queue gibt jeden Link an sein Plugin. Das meldet sich beim Hoster an und gibt nur die
Direkt-URL zurück. Die Download-Engine lädt die Bytes in Segmenten, speichert den Fortschritt pro
Segment in SQLite und verschiebt fertige Dateien in den Paketordner.

| Bereich | Wahl |
| --- | --- |
| Backend | Rust, tokio, axum |
| HTTP-Client | reqwest mit Cookie-Jar pro Account |
| DB | SQLite über sqlx, Migrations in `crates/haul/migrations` |
| Live-Updates | Server-Sent Events (`/api/events`) |
| Plugins | TypeScript → JS (esbuild), ausgeführt mit rquickjs im Rust-Prozess |
| Frontend | Vite, React, TanStack Router, Query, Table; per `rust-embed` im Binary |

```
crates/haul         Server (API, Engine, Plugin-Host, Click'n'Load)
crates/haul-cnl     Click'n'Load-Forwarder für den Desktop
packages/plugin-sdk Typen, Helfer, XFileSharing-Basis, Test-ctx für Plugins
plugins/ddownload   ddownload-Plugin
plugins/gofile      Gofile-Plugin (mit Ordner-Crawler)
plugins/mediafire   Mediafire-Plugin (mit Ordner-Crawler)
plugins/send        Send-Plugin (XFS, free und premium)
plugins/1fichier    1fichier-Plugin (mit Ordner-Crawler)
plugins/gdrive      Google-Drive-Plugin (Dateien)
plugins/datanodes   Datanodes-Plugin (XFS, free)
ui                  Web-UI
```

## Plugins

Ein Plugin macht nur *Link rein, Direkt-URL plus Header raus*. Alles mit Bytes macht der Rust-Core.

```ts
import { definePlugin, OfflineError } from '@haul/plugin-sdk';

export default definePlugin({
  id: 'example',
  version: 1,
  matches: [/https?:\/\/example\.com\/f\/(\w+)/i],
  accountRequired: false,

  async check(link, ctx) {
    const res = await ctx.http.get(link);
    return { online: res.status !== 404 };
  },

  async resolve(link, ctx) {
    const acc = ctx.account.get(); // { id, user, secret } oder null
    const res = await ctx.http.get(link, { followRedirects: false });
    if (res.status === 404) throw new OfflineError();
    return { url: res.header('location')!, headers: { Referer: link } };
  },
});
```

Fehler nehmen beide Sprachen direkt: `throw new OfflineError({ de: 'Datei gelöscht', en: 'File deleted' })`
(ein einfacher String gilt für beide). Wo eine Meldung ein String sein muss, etwa zum Zusammensetzen
oder für `AccountInfo.message`, packt `bilingual(de, en)` beide Texte in einen String; übersetzt wird
dabei nichts, die UI zeigt die gewählte Sprache (im Rust-Core entsprechend `tr!`).
Texte für das Account-Formular (`account.userLabel`, `secretLabel`, `help`) sind ein String oder
`{ de, en }`; die UI zeigt die gewählte Sprache.

`ctx` bietet `http.get/post/request` (Cookie-Jar pro Account, der Login bleibt zwischen Aufrufen
erhalten), `cookies.get/set`, `hash.sha256`, `wait(sec)`, `log` und `account.get()`.
Download-Passwörter liefert `ctx.password.get()` (das gespeicherte, sonst fragt Haul den Nutzer;
`{ wrong: true }` nach einer Ablehnung); `withPassword(ctx, name, versuch)` aus dem SDK kapselt JDs
Ablauf mit drei Versuchen (siehe `plugins/1fichier`, `plugins/mediafire`). Optional
`crawl(link)`: macht beim Hinzufügen aus einem Ordner-Link die einzelnen Datei-Links, mit Name
und Größe (siehe `plugins/gofile`). Fehler signalisiert ein Plugin mit
`OfflineError` (kein Retry), `TemporaryError` (später erneut) oder `AccountError`.
Für XFileSharing-Hoster gibt es `createXfsPlugin` in `@haul/plugin-sdk/xfs`; ddownload ist damit
fünf Zeilen Konfiguration. Mit `free: true` lädt die Basis ohne Account wie JDs `doFree`; weicht eine Seite ab, passen
`freeHooks` (Formulare, Countdown, Direktlink) und `headers` sie an (siehe `plugins/datanodes`).
Verlangt ein Hoster eine Wartezeit (Free-Limit), meldet das Plugin sie mit
`new TemporaryError(meldung, sekunden)`; der Core versucht es genau dann erneut, ohne dass es als
Fehlversuch zählt. Gilt die Sperre für den ganzen Hoster (IP-Limit, Free-Slots belegt; JD
`ERROR_IP_BLOCKED`), wirft das Plugin `new HosterLimitError(meldung, sekunden)`: dann warten alle
Downloads dieses Hosters, statt dass jeder einzeln gegen das Limit läuft.

Plugins werden mit `pnpm build:plugins` nach `plugins/dist/<name>.js` gebaut. Eigene oder
aktualisierte Plugins nach `/config/plugins/` legen und unter *Accounts & Plugins* auf
*Neu laden* klicken; sie überschreiben mitgelieferte mit derselben `id`. Ist das mitgelieferte
neuer als die eigene Kopie, zeigt die UI eine Warnung (die Kopie löschen, um Updates zu bekommen).

Ordner-Links (Plugins mit `crawl`) werden nach dem Speichern im Hintergrund aufgelöst; das
Hinzufügen, auch per Click'n'Load, wartet nicht darauf. Bis dahin steht der Link als
„Ordner wird gelesen …“ da, ein Neustart setzt offene Crawls fort.

Plugins lassen sich ohne Server testen, mit dem Fake-`ctx` aus `@haul/plugin-sdk/testing`
(siehe `plugins/ddownload/test`).

### Stand ddownload

Das Plugin deckt beide Wege ab, die JDownloader und pyLoad nutzen: Web-Login mit Premium-Formular
bzw. Direkt-Redirect, und die XFileSharing-API mit API-Key (Benutzer leer lassen, Key ins
Passwortfeld). Getestet ist es gegen nachgebaute Seiten, **noch nicht gegen einen echten
Premium-Account** (Meilenstein M0 im Plan). Weicht der echte Ablauf ab, reicht ein angepasstes
Plugin in `/config/plugins`, ohne neues Image.

## Entwicklung

Voraussetzungen: Rust (stable), Node 22, pnpm. Zum Entpacken 7-Zip und unrar, unter
Ubuntu/Debian `sudo apt install 7zip unrar` (unrar aus `multiverse`/`non-free`). Für RAR nimmt Haul
unrar zuerst: das RAR-Modul von 7-Zip 23.01 (`7zip-rar`) stürzt bei manchen Archiven ab. Haul
findet `7zz`, `7z`, `7za`, `unrar` und `unar` selbst; welche gefunden wurden, steht unter
*Einstellungen → Ordner*. Schlägt das Entpacken fehl, nennt die Meldung jeden versuchten Entpacker
mit Exit-Code bzw. Signal und seinen Fehlerzeilen; die ganze Ausgabe steht im Server-Log.

```sh
pnpm install
pnpm dev
```

`pnpm dev` legt beim ersten Mal `.env` aus [`.env.example`](.env.example) an, baut die Plugins und
startet Server (`:8080`) und UI mit Hot Reload (`:5173`) zusammen. Öffnen:
http://localhost:5173, Login `admin` / `adminadmin`. Daten landen in `./.data`.

Einstellungen stehen in `.env`; der Server liest sie beim Start selbst, also funktioniert auch
`cargo run -p haul` allein. Gesetzte Umgebungsvariablen haben Vorrang.

Tests und Checks:

```sh
cargo test --workspace        # Engine (Segmente, Pause/Resume), CNL2, QuickJS-Host, Limiter …
cargo clippy --workspace --all-targets -- -D warnings
pnpm test                     # SDK-Helfer und Hoster-Plugins gegen Fake-ctx
pnpm typecheck
```

## API

Alle Endpunkte unter `/api`, JSON. Authentifizierung per Session-Cookie (Web-UI) oder
`Authorization: Bearer <API-Token>`.

| Methode | Pfad | |
| --- | --- | --- |
| `POST` | `/links` | `{ links, packageName?, targetDir?, passwords?, start }` |
| `GET` | `/packages?view=queue\|collector` | Pakete mit Downloads |
| `PATCH`/`DELETE` | `/packages/{id}` | umbenennen, Zielordner, Passwörter / löschen |
| `POST` | `/packages/{id}/start\|pause\|resume\|check\|extract` | `start` optional mit `{ downloadIds }`: nur diese Dateien, der Rest bleibt im Linksammler |
| `POST`/`DELETE` | `/downloads/{id}/pause\|resume`, `/downloads/{id}` | |
| `POST` | `/downloads/pause-all\|resume-all\|clear-finished` | |
| `GET` | `/events` | SSE: `changed` und `progress` |
| `GET` | `/stats` | Slots, Warteschlange, Speicherplatz, Premium-Traffic |
| `GET`/`POST`/`PATCH`/`DELETE` | `/accounts…` | |
| `GET`/`POST` | `/plugins`, `/plugins/reload` | |
| `GET`/`PUT` | `/settings` | |
| `POST` | `/cnl/flash/add\|addcrypted2` | Click'n'Load über `haul-cnl` |

## Lizenz

GPL-3.0-or-later. Hoster-Plugins, die eng an JDownloader-Code angelehnt sind, gelten als
abgeleitetes Werk; deshalb steht das ganze Repo unter der GPLv3.
