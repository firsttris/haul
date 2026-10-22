# Installation

Haul ships as one container image: [`tristanteu/haul`](https://hub.docker.com/r/tristanteu/haul) for
`linux/amd64` and `linux/arm64`. It contains the server, the web UI, the built-in hoster plugins and the
extractors (`7z`, `unrar`). Without Docker, an install script sets up the same server as a systemd
service.

- [Docker Compose](#docker-compose)
- [Podman Quadlet](#podman-quadlet)
- [docker run](#docker-run)
- [Without Docker](#without-docker)
- [First start](#first-start)
- [Volumes](#volumes)
- [Environment variables](#environment-variables)
- [Updating](#updating)
- [Behind a reverse proxy](#behind-a-reverse-proxy)

## Docker Compose

```bash
mkdir haul && cd haul
curl -O https://raw.githubusercontent.com/firsttris/haul/main/docker/docker-compose.yml
# set APP_SECRET and your download folders, then
docker compose up -d
```

The file in [`docker/docker-compose.yml`](https://github.com/firsttris/haul/blob/main/docker/docker-compose.yml):

```yaml
services:
  haul:
    image: tristanteu/haul:latest
    container_name: haul
    restart: unless-stopped
    ports:
      - "8080:8080"
      - "127.0.0.1:9666:9666"   # Click'n'Load, only on the host's loopback
    volumes:
      - ./config:/config
      - ./downloads/tmp:/downloads/tmp
      - ./downloads/done:/downloads/done
    environment:
      - APP_SECRET=change-me    # openssl rand -hex 32
```

Point the two download volumes wherever your disks are, for example `/mnt/cache/downloads:/downloads/tmp`
and `/mnt/disk1/downloads:/downloads/done`.

## Podman Quadlet

For Podman with systemd, [`docker/`](https://github.com/firsttris/haul/tree/main/docker) has a Quadlet unit and network:

```bash
mkdir -p ~/.config/containers/systemd ~/haul/config ~/haul/downloads/{tmp,done}
cp docker/haul.container docker/haul.network ~/.config/containers/systemd/
# set APP_SECRET, adjust the Volume= lines
systemctl --user daemon-reload
systemctl --user start haul
```

For a start at boot without a login, install the files into `/etc/containers/systemd/` and use
`systemctl` without `--user` (or run `loginctl enable-linger $USER` for the user unit).

The unit sets `AutoUpdate=registry`, so `podman auto-update` pulls new releases.
Logs: `journalctl --user -u haul` or `podman logs haul`.

## docker run

```bash
docker run -d --name haul --restart unless-stopped \
  -p 8080:8080 -p 127.0.0.1:9666:9666 \
  -v ./config:/config \
  -v ./downloads/tmp:/downloads/tmp \
  -v ./downloads/done:/downloads/done \
  -e APP_SECRET="$(openssl rand -hex 32)" \
  tristanteu/haul:latest
```

Keep the `APP_SECRET` you used: without it, stored account passwords cannot be read.

## Without Docker

On a Linux machine with systemd (x86_64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/firsttris/haul/main/scripts/install.sh | sudo sh
```

The script downloads the release binary, which has the web UI and the hoster plugins built in and
needs no libraries, checks its SHA-256 and sets up:

| Path | Content |
|---|---|
| `/usr/local/bin/haul` | the server |
| `/etc/haul/haul.env` | the [environment variables](#environment-variables), with a generated `APP_SECRET`; written on the first install only |
| `/etc/systemd/system/haul.service` | runs Haul as the system user `haul` and starts it at boot |
| `/var/lib/haul` | database and your own plugins (`plugins/`) |
| `/var/lib/haul/downloads/tmp`, `…/done` | downloads in progress and finished downloads |

It also installs 7-Zip and unrar with the package manager (apt, dnf, pacman, zypper or apk). unrar is
not in every distribution's default sources (Debian: `non-free`, Ubuntu: `multiverse`, Fedora: RPM
Fusion); without it 7-Zip extracts RAR too. If no extractor could be installed, the downloads page
says so, and archives are extracted after you install one and click **Extract again**.

Options for the first install, before `sh`: `HAUL_DOWNLOADS=/mnt/disk1/downloads` puts the
downloads there, `HAUL_PORT=8090` changes the port, `HAUL_NO_EXTRACTORS=1` leaves the packages alone,
`HAUL_VERSION=1.2.3` picks a release. For example:

```bash
curl -fsSL https://raw.githubusercontent.com/firsttris/haul/main/scripts/install.sh | sudo HAUL_DOWNLOADS=/mnt/disk1/downloads sh
```

Later changes go to `/etc/haul/haul.env`, then `sudo systemctl restart haul`. Folders outside
`/var/lib/haul` must be writable by the user `haul` (`sudo chown -R haul:haul /mnt/disk1/downloads`).
Click'n'Load listens on `127.0.0.1:9666` of that machine; a browser there reaches it directly.

Logs: `journalctl -u haul -f`. To remove Haul:

```bash
sudo systemctl disable --now haul
sudo rm /usr/local/bin/haul /etc/systemd/system/haul.service
# with your settings, database and downloads:
sudo rm -r /etc/haul /var/lib/haul && sudo userdel haul
```

## First start

Open `http://<server>:8080`. On the first visit Haul asks you to create the login. To create it without
the UI, set `HAUL_USER` and `HAUL_PASSWORD` for the first start.

Then:

1. **Accounts & Plugins**: add your hoster accounts, see [Hosters](hosters.md).
2. **Settings → Captchas**: install the userscript if you use hosters with reCaptcha, hCaptcha or
   Turnstile, see [Captchas](captchas.md).
3. **Settings → Click'n'Load from the desktop**: create an API token if you want to send [Click'n'Load](click-n-load.md) links from your desktop.

## Volumes

| Path | Content |
|---|---|
| `/config` | SQLite database `haul.db` and your own plugins in `plugins/` |
| `/downloads/tmp` | Downloads in progress (`<id>.part`). Fast disk or cache drive recommended. |
| `/downloads/done` | Finished files, one folder per package. Archives are extracted here. |

`tmp` and `done` may be on different disks; Haul moves finished files across.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `APP_SECRET` | – (required) | Key that encrypts stored account passwords. Do not change it later. |
| `HAUL_USER`, `HAUL_PASSWORD` | – | Create the web login on the first start |
| `HAUL_CONFIG_DIR` | `/config` | Database and own plugins |
| `HAUL_TMP_DIR` | `/downloads/tmp` | Downloads in progress |
| `HAUL_DONE_DIR` | `/downloads/done` | Finished downloads |
| `HAUL_LISTEN` | `0.0.0.0:8080` | Web UI and API |
| `HAUL_CNL_LISTEN` | `0.0.0.0:9666` in the image, else `127.0.0.1:9666` | Click'n'Load; `off` turns it off. Publish it only on `127.0.0.1`. |
| `HAUL_BUILTIN_PLUGINS` | `/app/plugins` in the image, else unset | Folder with the plugins that come with Haul; unset means the ones built into the binary |
| `HAUL_USER_AGENT` | a desktop browser | User-Agent sent to hosters |
| `HAUL_7Z`, `HAUL_UNRAR` | found on `PATH` | Extractors: `7zz`, `7z` or `7za`, and `unrar` |
| `RUST_LOG` | `info,sqlx=warn` | Log level. `haul=debug` also saves the hoster pages of failed downloads, see [Debugging a hoster](plugins.md#debugging-a-hoster). |

## Settings in the UI

Everything else is under **Settings** in the web UI and stored in the database.

| Setting | Default | Range |
|---|---|---|
| Parallel downloads | 3 | 1–20 |
| Connections per file | 4 | 1–16, hosters may allow fewer |
| Bandwidth limit (KiB/s) | 0, no limit | over all downloads |
| Retries | 5 | 0–50 |
| Extract finished packages automatically | on | |
| Delete archives after successful extraction | off | |
| Remove the downloads from the list after successful extraction | off | |
| Ask for the archive password when none fits | on | |
| Verify the checksum after the download | on | |

The same page holds the [archive password list](extraction.md), the [captcha userscript](captchas.md),
the API token for [Click'n'Load](click-n-load.md), the folders and extractors Haul found, and:

- **Language**: German or English for this browser, including messages from the server and the
  hosters. It is also switchable at the bottom of the sidebar.
- **Login**: change your password, or log out.

## Health check

`GET /api/health` answers `{"status":"ok"}` without a login. The image uses it as its Docker
`HEALTHCHECK`, and you can point an uptime monitor at it.

## Updating

```bash
docker compose pull && docker compose up -d
```

With Podman: `podman auto-update`, or `systemctl --user restart haul` after `podman pull`.
Without Docker: run the [install script](#without-docker) again; it keeps `/etc/haul/haul.env`.
Downloads in progress resume after the restart.

Tags: `latest` is the latest release, `1.2.3` and `1.2` pin a version.

## Behind a reverse proxy

Haul is a single HTTP service on port 8080. The live progress uses Server-Sent Events on
`/api/events`, so the proxy must not buffer that path. With nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_buffering off;          # live progress (SSE)
    proxy_read_timeout 1h;
}
```

Caddy and Traefik need no extra settings for SSE.
