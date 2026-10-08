# Docker / Podman

Published image: [`tristanteu/haul`](https://hub.docker.com/r/tristanteu/haul) (`linux/amd64`,
`linux/arm64`). See [Installation](../docs/installation.md) for usage and configuration.

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build: UI and plugins (Node), server binary (Rust), Debian slim runtime with `7z` and `unrar` |
| `entrypoint.sh` | Hands the volumes to `PUID:PGID` and starts Haul as that user instead of root |
| `docker-compose.yml` | Compose setup with the published image, or `--build` to build from source |
| `haul.container` | Podman Quadlet unit |
| `haul.network` | Podman Quadlet network |

## Build from source

From the repository root:

```bash
docker build -f docker/Dockerfile -t haul .
```

## Podman Quadlet

```bash
mkdir -p ~/.config/containers/systemd ~/haul/config ~/haul/downloads/{tmp,done}
cp docker/haul.container docker/haul.network ~/.config/containers/systemd/
# set APP_SECRET, adjust the Volume= lines
systemctl --user daemon-reload
systemctl --user start haul
```

For a start at boot, install into `/etc/containers/systemd/` and use `systemctl` without `--user`, or
keep the user unit and run `loginctl enable-linger $USER`.

The unit sets `AutoUpdate=registry`, so `podman auto-update` pulls new releases.
Logs: `journalctl --user -u haul` or `podman logs haul`.
