#!/bin/bash
# Levanta PostgreSQL 16 desechable + API compilada + proxy estilo Replit.
# No usar como root (initdb lo rechaza): restart.sh se encarga de cambiar de usuario.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${E2E_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
D="${E2E_DIR:-/tmp/another-e2e}"
PG_PORT="${E2E_PG_PORT:-55432}"
API_PORT="${E2E_API_PORT:-58080}"
WEB_PORT="${E2E_WEB_PORT:-58000}"
PG_BIN="${E2E_PG_BIN:-/usr/lib/postgresql/16/bin}"
[ -x "$PG_BIN/initdb" ] || PG_BIN="$(dirname "$(command -v initdb)")"
export PATH="$PG_BIN:$PATH"

rm -rf "$D/pg" "$D/api"; mkdir -p "$D/api/uploads" "$D/shots" "$D/audit"
initdb -D "$D/pg" -A trust -U "$(whoami)" >/dev/null
pg_ctl -D "$D/pg" -o "-p $PG_PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$D/pg.log" -w start >/dev/null
createdb -h 127.0.0.1 -p "$PG_PORT" e2e
export DATABASE_URL="postgresql://$(whoami)@127.0.0.1:$PG_PORT/e2e"
(cd "$REPO" && pnpm --filter @workspace/db run migrate >/dev/null 2>&1)

cd "$D/api"
MESSAGE_ENCRYPTION_KEY="$(openssl rand -hex 32)" SESSION_SECRET="$(openssl rand -hex 32)" \
NODE_ENV=development LOG_LEVEL=warn PORT="$API_PORT" APP_URL="http://127.0.0.1:$WEB_PORT" \
  nohup node "$REPO/artifacts/api-server/dist/index.mjs" > "$D/api.log" 2>&1 &
nohup node "$HERE/proxy.mjs" "$WEB_PORT" "$API_PORT" "$REPO/artifacts/another-private/dist/public" > "$D/proxy.log" 2>&1 &
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$WEB_PORT/api/healthz" && break; sleep 0.5
done
curl -s -o /dev/null -w "healthz %{http_code}\n" "http://127.0.0.1:$WEB_PORT/api/healthz"
