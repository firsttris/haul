# Installation

Haul ships as one container image: [`tristanteu/haul`](https://hub.docker.com/r/tristanteu/haul) for
`linux/amd64` and `linux/arm64`. It contains the server, the web UI, the built-in hoster plugins and the
extractors (`7z`, `unrar`).

- [Docker Compose](#docker-compose)
- [Podman Quadlet](#podman-quadlet)
- [docker run](#docker-run)
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

The file in [`docker/docker-compose.yml`](../docker/docker-compose.yml):

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

For Podman with systemd, [`docker/`](../docker/) has a Quadlet unit and network:

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
| `HAUL_CNL_LISTEN` | `0.0.0.0:9666` in the image | Click'n'Load; `off` turns it off. Publish it only on `127.0.0.1`. |
| `HAUL_BUILTIN_PLUGINS` | `/app/plugins` in the image | Plugins that come with Haul |
| `HAUL_USER_AGENT` | a desktop browser | User-Agent sent to hosters |
| `HAUL_7Z`, `HAUL_UNRAR` | found on `PATH` | Extractors |
| `RUST_LOG` | `info` | Log level. `haul=debug` also saves the hoster pages of failed downloads, see [Debugging a hoster](plugins.md#debugging-a-hoster). |

Everything else (parallel downloads, connections per file, bandwidth limit, retries, extraction,
checksums) is under **Settings** in the UI.

## Updating

```bash
docker compose pull && docker compose up -d
```

With Podman: `podman auto-update`, or `systemctl --user restart haul` after `podman pull`.
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
