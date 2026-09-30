# Development

- [Setup](#setup)
- [Checks](#checks)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [API](#api)
- [Releases](#releases)

## Setup

Requirements: Rust (stable), Node.js 22, pnpm, and for extraction `7zip` and `unrar`
(Debian/Ubuntu: `sudo apt install 7zip unrar`, unrar is in `non-free`/`multiverse`).

```bash
git clone https://github.com/firsttris/haul
cd haul
pnpm install
pnpm dev
```

`pnpm dev` creates `.env` from [`.env.example`](../.env.example) on the first run, builds the plugins
and starts the server (`:8080`) and the UI with hot reload (`:5173`). Open http://localhost:5173 and log
in with `admin` / `adminadmin`. Data goes to `./.data`.

The server reads `.env` itself, so `cargo run -p haul` works on its own too. Variables set in the
environment take precedence.

## Checks

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
pnpm test          # SDK helpers and hoster plugins against a fake context
pnpm typecheck
```

CI runs all of them on every pull request and builds the image.

## Architecture

```
Browser ──HTTP/SSE──▶ axum ──▶ queue / engine ──▶ plugin (QuickJS) ──▶ direct URL
                        │            │
                        │            └──▶ download engine (reqwest, range segments) ──▶ tmp ──▶ done
                        └──▶ SQLite (/config/haul.db)
Desktop: web page ──▶ 127.0.0.1:9666 (haul-cnl) ──bearer token──▶ /api/cnl/flash/*
```

The queue hands every link to its plugin. The plugin logs in at the hoster and returns only the direct
URL. The download engine loads the bytes in segments, stores the progress of each segment in SQLite and
moves finished files into the package folder.

| Part | Choice |
|---|---|
| Backend | Rust, tokio, axum |
| HTTP client | reqwest with a cookie jar per account |
| Database | SQLite via sqlx, migrations in `crates/haul/migrations` |
| Live updates | Server-Sent Events (`/api/events`) |
| Plugins | TypeScript bundled with esbuild, run with rquickjs inside the server |
| Frontend | Vite, React, TanStack Router, Query and Table; embedded in the binary with rust-embed |

## Repository layout

```
crates/haul          server: API, engine, plugin host, Click'n'Load, extraction
crates/haul-cnl      Click'n'Load forwarder for the desktop
packages/plugin-sdk  types, helpers, XFileSharing base, test context for plugins
plugins/*            hoster plugins, one folder each, with tests
ui                   web UI
docker               Compose file and Podman Quadlet units
docs                 this documentation
```

## API

All endpoints are under `/api` and speak JSON. Authentication with the session cookie (web UI) or
`Authorization: Bearer <API token>`.

| Method | Path | |
|---|---|---|
| `POST` | `/links` | `{ links, packageName?, targetDir?, password?, start }`; `links` is text with one link per line; `password` is the download and first archive password, or separately `downloadPassword?`, `passwords?` |
| `GET` | `/packages?view=queue\|collector` | packages with their downloads |
| `PATCH` / `DELETE` | `/packages/{id}` | rename, target folder, passwords / delete |
| `POST` | `/packages/{id}/start\|pause\|resume\|check\|extract` | `start` takes `{ downloadIds }` to start only those; the rest stays in the link grabber |
| `POST` / `DELETE` | `/downloads/{id}/pause\|resume`, `/downloads/{id}` | |
| `POST` | `/downloads/pause-all\|resume-all\|clear-finished` | |
| `GET` | `/events` | SSE: `changed` and `progress` |
| `GET` | `/stats` | slots, queue, disk space, premium traffic |
| `GET` / `POST` / `PATCH` / `DELETE` | `/accounts…` | |
| `GET` / `POST` | `/plugins`, `/plugins/reload` | |
| `GET` / `PUT` | `/settings` | |
| `POST` | `/cnl/flash/add\|addcrypted2` | Click'n'Load through `haul-cnl` |

## Releases

Pushing a tag `v*` builds the image for `linux/amd64` and `linux/arm64` and publishes it to Docker Hub
as `tristanteu/haul` with the tags `latest`, `X.Y.Z` and `X.Y`. The repository needs the secret
`DOCKER_PAT`, a Docker Hub access token with write access.

```bash
git tag v0.1.0 && git push origin v0.1.0
```
