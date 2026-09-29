# Imagen única de A.N.O.T.H.E.R. Private para Coolify / Docker.
# La API sirve también el frontend (FRONTEND_DIST_DIR) y el WebSocket en /ws.
# Guía de despliegue: docs/despliegue/coolify.md
#
# Reglas que respeta (AGENTS.md):
# - pnpm con --frozen-lockfile y minimumReleaseAge intacto (§6).
# - Sin binarios del sistema en tiempo de ejecución (§6).
# - Sin secretos en la imagen: todo llega por variables de entorno (§7.7).
# - Las subidas de usuarios NO entran en la imagen: viven en el volumen /data (§7.7).
# - Migraciones con `drizzle-kit migrate`, nunca `push` (§4).

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------------------
# Build: dependencias, API (esbuild) y frontend (Vite)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=true
RUN npm install -g pnpm@10.28.0

COPY . .

# Solo los paquetes que se despliegan (el sandbox de maquetas queda fuera).
RUN pnpm install --frozen-lockfile \
      --filter "@workspace/api-server..." \
      --filter "@workspace/another-private..." \
      --filter "@workspace/db..."

RUN pnpm --filter @workspace/api-server run build

# vite.config.ts exige PORT y BASE_PATH también al compilar.
# Las VITE_* son PÚBLICAS en el cliente compilado: nunca pongas credenciales aquí.
ARG VITE_ICE_SERVERS=""
RUN PORT=5173 BASE_PATH=/ VITE_ICE_SERVERS="${VITE_ICE_SERVERS}" \
      pnpm --filter @workspace/another-private run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    FRONTEND_DIST_DIR=/app/artifacts/another-private/dist/public \
    RUN_MIGRATIONS=1

WORKDIR /app
COPY --from=build /app /app
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# /data es el volumen persistente: uploads/ y private-channel-files/ se crean ahí,
# porque la API resuelve ambas carpetas relativas al directorio de trabajo.
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data/uploads /data/private-channel-files \
 && chown -R node:node /data
VOLUME ["/data"]

USER node
WORKDIR /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
