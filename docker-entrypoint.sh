#!/bin/sh
set -e

# The /data volume is often a freshly-created, root-owned bind mount, which the
# unprivileged "node" user can't write to. When we start as root, make sure the
# data dir is owned by node, then drop privileges and run the app as node.
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec gosu node "$@"
fi

# Already running as a non-root user (e.g. `user:` override) — just run.
exec "$@"
