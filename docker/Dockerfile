# syntax=docker/dockerfile:1

# ---- 1. UI and plugins ---------------------------------------------------------------
# Base images pinned by digest (Dependabot keeps them current).
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Every workspace package has to be there for the install, or pnpm does not link
# @haul/plugin-sdk into the plugins that the build then bundles.
COPY scripts scripts
COPY packages packages
COPY plugins plugins
COPY ui ui
RUN pnpm install --frozen-lockfile && pnpm build

# ---- 2. Server binary (UI embedded via rust-embed) ------------------------------------
FROM rust:1-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY --from=web /src/ui/dist ui/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p haul && cp target/release/haul /haul

# ---- 3. Runtime ----------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
# unrar lives in non-free; p7zip handles zip/7z and split archives.
RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates p7zip-full unrar tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 haul \
    && useradd --uid 1000 --gid haul --no-create-home --home-dir /config --shell /usr/sbin/nologin haul \
    && mkdir -p /config /downloads/tmp /downloads/done \
    && chown haul:haul /config /downloads/tmp /downloads/done
COPY --from=server /haul /usr/local/bin/haul
COPY docker/entrypoint.sh /usr/local/bin/entrypoint
COPY --from=web /src/plugins/dist /app/plugins

ENV HAUL_CONFIG_DIR=/config \
    HAUL_TMP_DIR=/downloads/tmp \
    HAUL_DONE_DIR=/downloads/done \
    HAUL_BUILTIN_PLUGINS=/app/plugins \
    HAUL_LISTEN=0.0.0.0:8080 \
    # Inside the container Click'n'Load must listen on all interfaces so Docker can forward it.
    # Publish it only on the host's loopback: "127.0.0.1:9666:9666".
    HAUL_CNL_LISTEN=0.0.0.0:9666 \
    # Haul runs as this user and group; the entrypoint drops root (see entrypoint.sh).
    PUID=1000 \
    PGID=1000

VOLUME ["/config", "/downloads/tmp", "/downloads/done"]
EXPOSE 8080 9666
HEALTHCHECK --interval=30s --timeout=5s CMD ["/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /api/health HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q ok <&3"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint"]
CMD ["haul"]
