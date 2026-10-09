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

`pnpm dev` creates `.env` from [`.env.example`](https://github.com/firsttris/haul/blob/main/.env.example) on the first run, builds the plugins
and starts the server (`:8080`) and the UI with hot reload (`:5173`). Open http://localhost:5173 and log
in with `admin` / `adminadmin`. Data goes to `./.data`.

The server reads `.env` itself, so `cargo run -p haul` works on its own too. Variables set in the
environment take precedence. As long as no UI is built into the binary, `HAUL_DEV_UI`
(`http://localhost:5173` in `.env.example`) makes `:8080` redirect to the Vite dev server.

## Checks

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
pnpm test          # SDK helpers and hoster plugins against a fake context
pnpm typecheck
```

CI runs all of them on every pull request and builds the image.

The documentation in `docs/` is published to https://firsttris.github.io/haul/ by
[`docs.yml`](https://github.com/firsttris/haul/blob/main/.github/workflows/docs.yml) on every push to
`main` that touches it. To preview it locally:

```bash
pip install -r requirements-docs.txt
mkdocs serve        # http://localhost:8000
```

### Screenshots

The picture in the README (`docs/screenshot.png`) and the repository's social media image
(`docs/social-preview.png`, 1280 × 640, uploaded under *Settings → Social preview*, rendered
from `scripts/social-preview/social-preview.html`) come from `pnpm screenshots`. It starts a
fresh haul with its own data directory (`scripts/screenshots/serve.mjs`) whose `HTTP_PROXY`
points at a stand-in for the internet: the linked files are served there with their real sizes,
each at its own speed, so progress, speed and ETA are real. No hoster accounts and no internet
are needed. It needs `pnpm build`, `cargo build --release -p haul` and 7-Zip; unrar keeps the
"unrar is missing" note out of the picture.

```bash
pnpm screenshots
```

After a change to the look, run **Actions → Update screenshots → Run workflow**: it takes them
in the official Playwright image and commits the ones that changed.

## Architecture

How the server, the queue, the plugins and the downloads fit together is described in
[Architecture](architecture.md). In short:

| Part | Choice |
|---|---|
| Backend | Rust, tokio, axum |
| HTTP client | reqwest with a cookie jar per account |
| Database | SQLite via sqlx, migrations in `crates/haul/migrations` |
| Live updates | Server-Sent Events (`/api/events`) |
| Plugins | TypeScript bundled with esbuild, run with rquickjs inside the server |
| Frontend | Vite, React, TanStack Router, Query and Table; embedded in the binary with rust-embed |

### Texts

All texts of the UI and the server live in `ui/messages/{de,en}.json`
([Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs)); keys follow
`area_group_name` (`settings_title`, `server_extract_noSpace`). `pnpm --filter @haul/ui i18n` compiles
them to `ui/src/paraglide` (dev, build, typecheck and test do that on their own). Components call them
directly: `m.settings_title()`, `m.done_confirmDeleteOne({ name, dir: String(dir) })`; a key chosen at
runtime goes through `pickMsg(msgGroup.disks, id)`. Placeholders are `{name}`, a literal brace is `\{`.

The server does not render texts: `crate::msg!("server_files_notFoundAt", path = rel)` sends the key
and its inputs, and the UI renders them with `localize()` in the viewer's language, also for errors
stored long ago. Logs show messages as `key {inputs}` (`i18n::plain`). Plugins still write both texts
side by side (`bilingual()` from the plugin SDK), and the browser extension keeps its own `_locales`.

`ui/src/i18n.test.ts` checks that both languages have the same keys and placeholders, that every
message is used (UI and server) and every used key exists; `cargo test` checks the server's keys too.

## Repository layout

```
crates/haul          server: API, engine, plugin host, Click'n'Load, extraction
crates/haul-cnl      Click'n'Load forwarder for the desktop
packages/plugin-sdk  types, helpers, XFileSharing base, test context for plugins
plugins/*            hoster plugins, one folder each, with tests
ui                   web UI
extension            browser extension for Chrome and Firefox (pnpm build:extension)
docker               Dockerfile, Compose file and Podman Quadlet units
docs                 this documentation (mkdocs.yml, requirements-docs.txt)
scripts              dev.mjs (pnpm dev), build-plugins.mjs, screenshots/ (pnpm screenshots)
.github/workflows    CI, extension, docs, screenshots, bump and release
```

## API

All endpoints are under `/api` and speak JSON. Authentication with the session cookie (web UI) or
`Authorization: Bearer <API token>`, created under **Settings → Click'n'Load from the desktop**.

| Method | Path | |
|---|---|---|
| `POST` | `/links` | `{ links, packageName?, targetDir?, password?, start? }`; `links` is text with one link per line; `start` defaults to `false` (link grabber); `password` is the download and first archive password, or separately `downloadPassword?`, `passwords?`; also `source?`, `sourcePage?`. Answers `{ packageId }`. |
| `GET` | `/packages?view=queue\|collector` | packages with their downloads |
| `PATCH` / `DELETE` | `/packages/{id}` | rename, target folder, passwords / delete |
| `POST` | `/packages/{id}/start\|pause\|resume\|check\|extract` | `start` takes `{ downloadIds }` to start only those; the rest stays in the link grabber |
| `POST` / `DELETE` | `/downloads/{id}/pause\|resume`, `/downloads/{id}` | |
| `POST` | `/downloads/pause-all\|resume-all\|clear-finished` | |
| `GET` | `/events` | SSE: `changed` and `progress` |
| `GET` | `/stats` | slots, queue, disk space, premium traffic |
| `GET` / `POST` | `/accounts` | list / add |
| `PATCH` / `DELETE` | `/accounts/{id}` | change / delete |
| `POST` | `/accounts/{id}/check` | log in and refresh premium state and traffic |
| `GET` | `/files`, `/files/folders` | the done folder; every folder in it as move targets |
| `POST` | `/files/delete\|delete-archives\|extract\|move\|mkdir` | Done view actions, paths relative to the done folder |
| `GET` / `POST` | `/plugins`, `/plugins/reload` | |
| `GET` / `PUT` | `/settings` | |
| `GET` / `PUT` | `/settings/archive-passwords` | the archive password list |
| `POST` | `/settings/api-token` | a new API token, shown once; replaces the old one |
| `POST` | `/auth/password` | change the login password |
| `GET` | `/captchas` | captchas and questions waiting for the user |
| `POST` | `/captchas/{id}/cancel` | cancel one |
| `POST` | `/cnl/flash/add\|addcrypted2` | Click'n'Load through `haul-cnl` |

Without login:

| Method | Path | |
|---|---|---|
| `GET` | `/health` | `{"status":"ok"}`, used by the Docker health check |
| `GET` | `/auth/state` | whether a user exists and the session is valid |
| `POST` | `/auth/setup\|login\|logout` | create the first user, log in, log out |
| `POST` | `/captcha/solve` | the userscript sends a solved captcha; the challenge's one-time secret is the proof |
| `GET` | `/captcha/haul-captcha.user.js` | the userscript |

The Click'n'Load port `9666` serves `/jdcheck.js`, `/crossdomain.xml`, `/flash`, `/flash/add` and
`/flash/addcrypted2` without login, as link sites expect.

## Releases

A version is a tag that matches `version` in `Cargo.toml` (`[workspace.package]`). The simplest way:
*Actions → Bump version → Run workflow* with patch, minor or major
([`bump.yml`](https://github.com/firsttris/haul/blob/main/.github/workflows/bump.yml), the shared
[`bump-version`](https://github.com/firsttris/workflows#bump-version)). It raises the version in
`Cargo.toml` and `Cargo.lock`, commits it as `Release vX.Y.Z`, tags it and starts the release. By hand:
raise the version there, commit, then

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The tag push starts the *Release* workflow (CI and extension here, the rest from the shared
[`docker-release.yml`](https://github.com/firsttris/workflows) in `firsttris/workflows`):

1. the full CI and the browser extension build,
2. the tag must match the version in `Cargo.toml`,
3. the image is built for `linux/amd64` and `linux/arm64`, each on its own native runner (Rust under
   QEMU takes too long), and published to Docker Hub as `tristanteu/haul` with the tags `X.Y.Z`,
   `X.Y` and `latest`; the README becomes the Docker Hub description,
4. only then the GitHub release with generated notes and the extension ZIPs for Chrome and Firefox.

Started by hand on `main` (Actions → *Release* → Run workflow), the workflow runs the same checks and
publishes the image as `edge`; nothing is released. The repository needs the secret `DOCKER_PAT`, a
Docker Hub access token with write access.
