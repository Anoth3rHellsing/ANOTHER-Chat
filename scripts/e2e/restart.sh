#!/bin/bash
# Para la pila anterior, levanta una limpia y siembra datos sintéticos.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_PORT="${E2E_PG_PORT:-55432}"
ps -eo pid,comm,args | awk '$2=="node" && ($0 ~ /api-server\/dist\/index.mjs/ || $0 ~ /e2e\/proxy.mjs/) {print $1}' | xargs -r kill
ps -eo pid,comm,args | awk -v port="$PG_PORT" '$2=="postgres" && $0 ~ ("-p " port) {print $1}' | xargs -r kill -9
sleep 2; rm -f "/tmp/.s.PGSQL.$PG_PORT"*
if [ "$(id -u)" = "0" ]; then
  PG_USER="${E2E_PG_USER:-pgtest}"
  id "$PG_USER" >/dev/null 2>&1 || useradd -m "$PG_USER"
  mkdir -p "${E2E_DIR:-/tmp/another-e2e}"; chmod 777 "${E2E_DIR:-/tmp/another-e2e}"
  su "$PG_USER" -s /bin/bash -c "export PATH='$PATH' HOME=/tmp E2E_DIR='${E2E_DIR:-/tmp/another-e2e}' E2E_REPO='${E2E_REPO:-}'; bash '$HERE/up.sh'"
else
  bash "$HERE/up.sh"
fi
node "$HERE/seed.mjs"
