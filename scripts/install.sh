#!/bin/sh
# Installs or updates Haul as a systemd service, without Docker:
#
#   curl -fsSL https://raw.githubusercontent.com/firsttris/haul/main/scripts/install.sh | sudo sh
#
# Run it again to update. What it sets up (see docs/installation.md#without-docker):
#   /usr/local/bin/haul             the server, with web UI and hoster plugins built in
#   /etc/haul/haul.env              settings, with a generated APP_SECRET (written once, kept on updates)
#   /etc/systemd/system/haul.service runs Haul as the system user "haul"
#   /var/lib/haul                   database and own plugins
#   /var/lib/haul/downloads         downloads, unless HAUL_DOWNLOADS says otherwise on the first install
# and installs 7-Zip and unrar for extraction where the package manager has them.
#
# Variables:
#   HAUL_VERSION=1.2.3     install that release instead of the latest
#   HAUL_DOWNLOADS=/path   download folder on the first install (tmp/ and done/ inside)
#   HAUL_PORT=8080         port of the web UI on the first install
#   HAUL_NO_EXTRACTORS=1   do not install 7-Zip and unrar
set -eu

REPO=firsttris/haul
BIN=/usr/local/bin/haul
ENV_FILE=/etc/haul/haul.env
UNIT=/etc/systemd/system/haul.service
DATA=/var/lib/haul

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root, e.g.: curl -fsSL … | sudo sh"
[ "$(uname -s)" = Linux ] || die "Haul's binary is for Linux only; use Docker elsewhere."
[ -d /run/systemd/system ] || die "systemd is not running; use Docker, or start $BIN yourself."

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x86_64 ;;
  aarch64 | arm64) ARCH=aarch64 ;;
  *) die "No Haul binary for $(uname -m); use Docker or build from source." ;;
esac

fetch() {
  if have curl; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif have wget; then
    wget -q -O "$2" "$1"
  else
    die "Neither curl nor wget found."
  fi
}

# ---- 1. Binary --------------------------------------------------------------------------
ASSET="haul-linux-$ARCH.tar.gz"
if [ -n "${HAUL_VERSION:-}" ]; then
  URL="https://github.com/$REPO/releases/download/v${HAUL_VERSION#v}/$ASSET"
else
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "Downloading $URL"
fetch "$URL" "$TMP/$ASSET" || die "Download failed: $URL"
fetch "$URL.sha256" "$TMP/$ASSET.sha256" || die "Download failed: $URL.sha256"
if have sha256sum; then
  (cd "$TMP" && sha256sum -c "$ASSET.sha256" >/dev/null) || die "Checksum of $ASSET does not match."
else
  warn "sha256sum not found, the checksum is not verified."
fi
tar -xzf "$TMP/$ASSET" -C "$TMP"
UPDATE=false
[ -f "$BIN" ] && UPDATE=true
install -m 0755 "$TMP/haul" "$BIN"

# ---- 2. User, folders, settings ---------------------------------------------------------
if ! id haul >/dev/null 2>&1; then
  NOLOGIN=$(command -v nologin || echo /bin/false)
  if have useradd; then
    useradd --system --home-dir "$DATA" --no-create-home --shell "$NOLOGIN" haul
  else
    adduser -S -D -H -h "$DATA" -s "$NOLOGIN" haul
  fi
fi

if [ ! -f "$ENV_FILE" ]; then
  DOWNLOADS=${HAUL_DOWNLOADS:-$DATA/downloads}
  if have openssl; then
    SECRET=$(openssl rand -hex 32)
  else
    SECRET=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
  fi
  mkdir -p "$(dirname "$ENV_FILE")"
  cat >"$ENV_FILE" <<EOF
# Haul settings, read by haul.service. After a change: systemctl restart haul
# All variables: https://firsttris.github.io/haul/installation.html#environment-variables

# Encrypts stored account passwords. Keep it: without it they cannot be read any more.
APP_SECRET=$SECRET

HAUL_CONFIG_DIR=$DATA
HAUL_TMP_DIR=$DOWNLOADS/tmp
HAUL_DONE_DIR=$DOWNLOADS/done
HAUL_LISTEN=0.0.0.0:${HAUL_PORT:-8080}
# Click'n'Load only on this machine; haul-cnl or an SSH tunnel forwards from other ones.
HAUL_CNL_LISTEN=127.0.0.1:9666
EOF
  chown root:haul "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  say "Settings written to $ENV_FILE"
fi

# The folders from the settings, also when they were changed there.
dir_of() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
for dir in "$DATA" "$(dir_of HAUL_CONFIG_DIR)" "$(dir_of HAUL_TMP_DIR)" "$(dir_of HAUL_DONE_DIR)"; do
  [ -n "$dir" ] || continue
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    chown haul:haul "$dir"
  fi
done
chown haul:haul "$DATA"

# ---- 3. Extractors ----------------------------------------------------------------------
pkg_install() {
  if have apt-get; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null 2>&1
  elif have dnf; then
    dnf install -y -q "$@" >/dev/null 2>&1
  elif have pacman; then
    pacman -S --noconfirm --needed "$@" >/dev/null 2>&1
  elif have zypper; then
    zypper --non-interactive -q install "$@" >/dev/null 2>&1
  elif have apk; then
    apk add -q "$@" >/dev/null 2>&1
  else
    return 1
  fi
}
has_7z() { have 7zz || have 7z || have 7za; }
if [ -z "${HAUL_NO_EXTRACTORS:-}" ]; then
  if ! has_7z || ! have unrar; then
    say "Installing 7-Zip and unrar for extraction"
    if have apt-get; then apt-get update -qq >/dev/null 2>&1 || true; fi
  fi
  if ! has_7z; then
    # Current 7-Zip first, p7zip on older releases.
    pkg_install 7zip || pkg_install p7zip-full || pkg_install p7zip p7zip-plugins || pkg_install p7zip || true
  fi
  if ! have unrar; then
    pkg_install unrar || true
  fi
  has_7z || warn "7-Zip could not be installed: archives are not extracted until it is (the web UI says so too)."
  have unrar || warn "unrar could not be installed (Debian: non-free, Ubuntu: multiverse, Fedora: RPM Fusion). 7-Zip extracts RAR, but unrar is more reliable."
fi

# ---- 4. Service -------------------------------------------------------------------------
cat >"$UNIT" <<EOF
# Written by Haul's install.sh; it is replaced on updates. Own changes: systemctl edit haul
[Unit]
Description=Haul download manager
Documentation=https://firsttris.github.io/haul/
After=network-online.target
Wants=network-online.target

[Service]
User=haul
Group=haul
EnvironmentFile=$ENV_FILE
ExecStart=$BIN
Restart=on-failure
RestartSec=5
# Downloads in progress are written on stop; give them time.
TimeoutStopSec=30
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
if [ "$UPDATE" = true ]; then
  systemctl enable haul >/dev/null 2>&1
  systemctl restart haul
  say "Haul updated: $("$BIN" --version 2>/dev/null || echo "$URL")"
else
  systemctl enable --now haul >/dev/null 2>&1
  PORT=$(dir_of HAUL_LISTEN | sed 's/.*://')
  HOST=$(hostname -I 2>/dev/null | awk '{print $1}')
  say "Haul is running: http://${HOST:-localhost}:${PORT:-8080}"
  echo "On the first visit it asks you to create the login."
  echo "Settings: $ENV_FILE  ·  Logs: journalctl -u haul -f  ·  Update: run this script again"
fi
