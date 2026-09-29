# Haul

Headless-Download-Server mit Web-UI für den Heimserver. Ein Binary in einem Docker-Container:
Links einfügen oder per Click'n'Load schicken, der Server lädt, der Browser zeigt den Fortschritt live.

**v1 kann:**

- direkte HTTP-Links
- ddownload mit Premium-Account (Web-Login oder API-Key)
- Gofile ohne Account: Ordner-Links werden beim Hinzufügen in ihre Dateien aufgelöst (mit
  Unterordnern, Paketname = Ordnername), Download mit Gast-Token; der Direktlink aus dem Ordner wird
  wiederverwendet und API-Anfragen laufen nacheinander (Rate-Limit für Gäste)
- Mediafire ohne Account: Datei-, Ordner- (mit Unterordnern) und Direktlinks; Name und Größe über
  die Mediafire-API schon beim Hinzufügen; Mediafires Checkbox-„Captcha“ wird automatisch bestätigt,
  beim IP-Limit wird wie bei JDownloader ein anderer User-Agent probiert
- Queue mit N parallelen Downloads, segmentiertes Laden über Range-Requests, `.part`-Dateien,
  Resume nach Neustart, Retry mit Backoff, globales Bandbreitenlimit
- Linksammler mit Online-Check, Paketname, Zielordner und Archiv-Passwörtern
- Click'n'Load (CNL1 und CNL2) über `haul-cnl` auf dem Desktop
- automatisches Entpacken fertiger Pakete mit `7z`/`unrar`, mit Fortschritt in Prozent
- Ansicht **Fertig**: der Fertig-Ordner wie auf der Platte, mit Paketzustand (entpackt, Archive übrig,
  Fehler, nicht von Haul); Auswahl per Checkbox, dann Entpacken (ein beliebiger Teil entpackt den ganzen
  Satz, in denselben Ordner), Verschieben in andere Ordner, neuer Ordner, Archive löschen, Löschen

- Weboberfläche auf Deutsch und Englisch (Browsersprache, umschaltbar unten in der Seitenleiste
  und unter *Einstellungen*); Meldungen von Server und Hostern sind bisher deutsch

**Bewusst nicht in v1:** Free-Downloads mit Captcha, DLC-Container, Multi-User, passwortgeschützte
Gofile-Ordner.

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

Texte für das Account-Formular (`account.userLabel`, `secretLabel`, `help`) sind ein String oder
`{ de, en }`; die UI zeigt die gewählte Sprache.

`ctx` bietet `http.get/post/request` (Cookie-Jar pro Account, der Login bleibt zwischen Aufrufen
erhalten), `cookies.get/set`, `hash.sha256`, `wait(sec)`, `log` und `account.get()`. Optional
`crawl(link)`: macht beim Hinzufügen aus einem Ordner-Link die einzelnen Datei-Links, mit Name
und Größe (siehe `plugins/gofile`). Fehler signalisiert ein Plugin mit
`OfflineError` (kein Retry), `TemporaryError` (später erneut) oder `AccountError`.
Für XFileSharing-Hoster gibt es `createXfsPlugin` in `@haul/plugin-sdk/xfs`; ddownload ist damit
fünf Zeilen Konfiguration.

Plugins werden mit `pnpm build:plugins` nach `plugins/dist/<name>.js` gebaut. Eigene oder
aktualisierte Plugins nach `/config/plugins/` legen und unter *Accounts & Plugins* auf
*Neu laden* klicken; sie überschreiben mitgelieferte mit derselben `id`.

Plugins lassen sich ohne Server testen, mit dem Fake-`ctx` aus `@haul/plugin-sdk/testing`
(siehe `plugins/ddownload/test`).

### Stand ddownload

Das Plugin deckt beide Wege ab, die JDownloader und pyLoad nutzen: Web-Login mit Premium-Formular
bzw. Direkt-Redirect, und die XFileSharing-API mit API-Key (Benutzer leer lassen, Key ins
Passwortfeld). Getestet ist es gegen nachgebaute Seiten, **noch nicht gegen einen echten
Premium-Account** (Meilenstein M0 im Plan). Weicht der echte Ablauf ab, reicht ein angepasstes
Plugin in `/config/plugins`, ohne neues Image.

## Entwicklung

Voraussetzungen: Rust (stable), Node 22, pnpm. Zum Entpacken 7-Zip mit RAR-Modul, unter
Ubuntu/Debian `sudo apt install 7zip 7zip-rar` (alternativ `7zip unrar`). Haul findet `7zz`, `7z`,
`7za`, `unrar` und `unar` selbst; welche gefunden wurden, steht unter *Einstellungen → Ordner*.

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
| `POST` | `/packages/{id}/start\|pause\|resume\|check\|extract` | |
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
