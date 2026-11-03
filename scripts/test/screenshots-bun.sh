#!/usr/bin/env bash
# Test: the Install step of .github/workflows/screenshots.yml installs the Bun that packageManager
# in package.json pins, in the Playwright image the job runs in, also when that Bun is not npm's
# latest. Needs Docker and the npm registry. Run: scripts/test/screenshots-bun.sh
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
want=1.3.0 # an older Bun than npm's latest, so "whatever npm installs" does not pass by chance
playwright=$(grep -oE '@playwright/test@[0-9]+\.[0-9]+\.[0-9]+' "$root/bun.lock" | head -1 | cut -d@ -f3)
image=mcr.microsoft.com/playwright:v$playwright-noble

# The script of the Install step up to Bun itself (`bun install` would need the whole repository)
step=$(awk '/- name: Install$/ { s = 1; next } s && /^ +- / { exit } s && /^ +run: \|/ { r = 1; next } r' \
  "$root/.github/workflows/screenshots.yml" | sed 's/^ *//' | grep -v '^bun install')
[ -n "$step" ] || { echo "FAIL: no Install step in screenshots.yml"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
sed -E "s/\"packageManager\": \"bun@[^\"]+\"/\"packageManager\": \"bun@$want\"/" "$root/package.json" > "$work/package.json"

# Behind a proxy (HTTPS_PROXY, NODE_EXTRA_CA_CERTS), hand it on to npm in the container
args=(--rm --network host -v "$work:/w" -w /w)
proxy=${HTTPS_PROXY:-${https_proxy:-}}
[ -z "$proxy" ] || args+=(-e "npm_config_https_proxy=$proxy" -e "npm_config_proxy=$proxy")
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
  args+=(-v "$NODE_EXTRA_CA_CERTS:/ca.crt:ro" -e NODE_EXTRA_CA_CERTS=/ca.crt -e npm_config_cafile=/ca.crt)
fi

got=$(docker run "${args[@]}" "$image" bash -e -c "{ $step
} >&2; bun --version")
if [ "$got" != "$want" ]; then
  echo "FAIL: packageManager pins bun@$want, the Install step installed bun $got"
  exit 1
fi
echo "ok: the Install step installs bun $got"
