#!/bin/sh
# Arranque del contenedor: migraciones versionadas y después la API.
# - Nunca usa `drizzle-kit push` (AGENTS.md §4).
# - Si una migración falla, el contenedor no arranca: mejor caído que a medias.
# - RUN_MIGRATIONS=0 desactiva el paso para aplicarlas a mano.
set -eu

for name in DATABASE_URL SESSION_SECRET MESSAGE_ENCRYPTION_KEY APP_URL; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "Falta la variable obligatoria $name" >&2
    exit 1
  fi
done

if [ "${RUN_MIGRATIONS:-1}" = "1" ]; then
  echo "Aplicando migraciones versionadas..."
  cd /app/lib/db
  ./node_modules/.bin/drizzle-kit migrate --config ./drizzle.config.ts
fi

# La API resuelve uploads/ y private-channel-files/ desde el directorio de trabajo.
cd /data
mkdir -p uploads private-channel-files
exec node --enable-source-maps /app/artifacts/api-server/dist/index.mjs
