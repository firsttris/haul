#!/bin/sh
# Starts Haul as PUID:PGID (default 1000:1000) instead of root: an extractor bug on a hostile
# archive then gets an unprivileged user, not root with write access to every volume.
#
# Started as root (the default), the volume folders are given to that user first. Folders still
# owned by root (written by an image before 0.1.2, which ran as root) are handed over with their
# content, once; folders owned by someone else are left alone.
# PUID=0 keeps running as root, e.g. with rootless Podman, where root in the container is the
# host user. Started as another user (`user:` in compose, `--user`), nothing is changed.
set -eu

if [ "$(id -u)" != 0 ] || [ "${PUID:-1000}" = 0 ]; then
  exec "$@"
fi

uid="${PUID:-1000}"
gid="${PGID:-1000}"
for dir in "$HAUL_CONFIG_DIR" "$HAUL_TMP_DIR" "$HAUL_DONE_DIR"; do
  mkdir -p "$dir"
  if [ "$(stat -c %u "$dir")" = 0 ]; then
    echo "entrypoint: handing $dir to $uid:$gid" >&2
    chown -R "$uid:$gid" "$dir"
  fi
done

exec setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$@"
