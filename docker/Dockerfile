# syntax=docker/dockerfile:1

# ---- 1. UI and plugins ---------------------------------------------------------------
FROM node:26-bookworm-slim AS web
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
# cargo-chef splits the build: the dependencies are cooked from a recipe of the manifests alone,
# a layer the build cache keeps until Cargo.toml or Cargo.lock change (the recipe leaves out the
# workspace crates' versions, so a release does not change it); only the workspace crates
# compile on a code change.
FROM rust:1-bookworm AS chef
RUN cargo install cargo-chef --version 0.1.78 --locked
WORKDIR /src

FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS server
COPY --from=planner /src/recipe.json recipe.json
RUN cargo chef cook --release -p haul --recipe-path recipe.json
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY --from=web /src/ui/dist ui/dist
RUN cargo build --release -p haul && cp target/release/haul /haul

# ---- 3. Runtime ----------------------------------------------------------------------
FROM debian:bookworm-slim
# unrar lives in non-free; p7zip handles zip/7z and split archives.
RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates p7zip-full unrar tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=server /haul /usr/local/bin/haul
COPY --from=web /src/plugins/dist /app/plugins

ENV HAUL_CONFIG_DIR=/config \
    HAUL_TMP_DIR=/downloads/tmp \
    HAUL_DONE_DIR=/downloads/done \
    HAUL_BUILTIN_PLUGINS=/app/plugins \
    HAUL_LISTEN=0.0.0.0:8080 \
    # Inside the container Click'n'Load must listen on all interfaces so Docker can forward it.
    # Publish it only on the host's loopback: "127.0.0.1:9666:9666".
    HAUL_CNL_LISTEN=0.0.0.0:9666

VOLUME ["/config", "/downloads/tmp", "/downloads/done"]
EXPOSE 8080 9666
HEALTHCHECK --interval=30s --timeout=5s CMD ["/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /api/health HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q ok <&3"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["haul"]
