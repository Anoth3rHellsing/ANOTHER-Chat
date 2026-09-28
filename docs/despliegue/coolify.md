# Despliegue en Coolify (servidor propio)

Guía para ejecutar A.N.O.T.H.E.R. Private fuera de Replit, en un servidor propio con [Coolify](https://coolify.io). La imagen es una sola: la API sirve también el frontend y el WebSocket.

> Mientras producción siga en Replit, **nada de esto cambia Replit**. El `Dockerfile` solo se usa fuera de él.

---

## 1. Qué hay en la imagen

| Pieza | Dónde |
|---|---|
| API + WebSocket (`/api`, `/ws`) | `node /app/artifacts/api-server/dist/index.mjs` |
| Frontend compilado | `/app/artifacts/another-private/dist/public`, servido por la API (`FRONTEND_DIST_DIR`) |
| Migraciones | `drizzle-kit migrate` al arrancar (`scripts/docker-entrypoint.sh`). **Nunca** `push` |
| Datos persistentes | Volumen **`/data`**: `uploads/` y `private-channel-files/` |
| Puerto | `8080` |
| Healthcheck | `GET /api/healthz` |

Las subidas de usuarios, `.replit` y los `.env` **no** entran en la imagen (`.dockerignore`).

---

## 2. El servidor

- Coolify ejecuta todo en Docker: a la aplicación le da igual la distribución del anfitrión.
- **Arch (o derivadas):** funciona, pero es de actualización continua. Actualiza con calma y con copias hechas; un `pacman -Syu` puede tocar el kernel o Docker. Debian/Ubuntu LTS son la opción conservadora.
- **Laptop como servidor:** tapa cerrada sin suspender (`HandleLidSwitch=ignore` en `/etc/systemd/logind.conf`), siempre enchufada, Ethernet si es posible.
- **HTTPS es obligatorio**: el micrófono (`getUserMedia`) solo funciona en contexto seguro. Coolify gestiona Let's Encrypt si el dominio apunta al servidor.

### Acceso desde internet

- Con IP pública y puertos 80/443 abiertos: apunta el dominio al servidor y Coolify emite el certificado.
- **Con CGNAT** (habitual en conexiones domésticas): no se pueden abrir puertos. Usa un **Cloudflare Tunnel**.
  - ⚠️ El túnel añade un proxy. Con `trust proxy = 1` la API vería la IP del túnel y **todos los usuarios compartirían los límites de tasa**. Ajustarlo es un cambio de política (AGENTS.md §7.6): PR propio y aprobación del propietario. **No lo cambies en la configuración del despliegue.**

---

## 3. Recursos en Coolify

1. **PostgreSQL 16**: recurso de base de datos. Anota la URL interna.
   - Configura las **copias programadas** a un destino fuera de la máquina (S3 compatible).
2. **Aplicación**: *Public/Private Repository* → este repositorio, rama `main`, *Build Pack*: **Dockerfile**.
   - Puerto expuesto: `8080`.
   - **Almacenamiento persistente:** volumen montado en **`/data`**.
   - **Réplicas: 1.** El proceso guarda estado en memoria (voz, llamadas, límites de tasa). Con dos instancias el chat se parte en dos (AGENTS.md §12).
   - Dominio con `https://`.

### Variables de entorno

| Variable | Obligatoria | Notas |
|---|---|---|
| `DATABASE_URL` | Sí | URL interna del PostgreSQL de Coolify |
| `SESSION_SECRET` | Sí | Aleatoria y larga |
| `MESSAGE_ENCRYPTION_KEY` | Sí | 64 hex. **La misma que la base que restaures**, o el historial queda ilegible (§7.5) |
| `APP_URL` | Sí | Origen público exacto, p. ej. `https://chat.ejemplo.com` (sin ruta). Sin él, CORS rechaza el registro |
| `Giphy` | No | Clave de Giphy (solo servidor) |
| `VIRUSTOTAL_API_KEY` | No | Solo servidor |
| `RUN_MIGRATIONS` | No | `1` por defecto. `0` para aplicarlas a mano |

Argumento de build opcional: `VITE_ICE_SERVERS`. **Es público** en el cliente compilado: nunca pongas credenciales TURN ahí (§7.7).

`NODE_ENV=production`, `PORT=8080` y `FRONTEND_DIST_DIR` ya vienen fijados en la imagen.

Si falta una variable obligatoria, el contenedor **no arranca** y lo dice en el log.

---

## 4. Migrar los datos desde Replit

Hazlo en una ventana de mantenimiento: los mensajes que lleguen a Replit durante la copia se perderían.

1. **Base de producción** (no la de desarrollo): `pg_dump --format=custom` desde Replit, `pg_restore` en el PostgreSQL de Coolify **antes** del primer arranque de la aplicación.
2. **Archivos**: copia `uploads/` y `private-channel-files/` del disco de producción de Replit al volumen `/data`.
3. **Secretos**: la misma `MESSAGE_ENCRYPTION_KEY` que producción.
4. **URLs antiguas**: las filas existentes pueden guardar URLs absolutas con el dominio de Replit (avatares, iconos, banners, historias). Hay que reescribirlas a relativas. *Pendiente de un PR propio.*
5. Arranca la aplicación: las migraciones pendientes se aplican solas y el log dice `migrations applied successfully!`.
6. Comprueba: entrar con una cuenta real, ver un avatar antiguo, enviar un mensaje, llamada de voz entre dos personas.

---

## 5. Despliegue continuo

Coolify puede redesplegar en cada *push* a `main`. Lo recomendable es que despliegue **solo si el CI está en verde**, llamando al webhook de despliegue de Coolify desde el último paso de `.github/workflows/ci.yml`. *Pendiente de un PR propio.*

Recuerda: publicar **no** ejecuta la suite de regresión. El CI sí.

---

## 6. Cómo se verificó esta imagen

- Build real del `Dockerfile` (con una imagen base Node 24 local equivalente, porque el entorno de verificación no tenía acceso a Docker Hub).
- Contenedor contra PostgreSQL 16 real y vacío: migraciones aplicadas, `healthz` 200, `index.html` servido.
- Chromium real a 1280 px y a 390 px táctil: inicio de sesión, recarga de una ruta del cliente, tramas WebSocket recibidas, sin `pageerror` ni desbordamiento.
- Avatar subido, contenedor **recreado**: el archivo sigue en `/data`, se sirve con sesión (200) y se rechaza sin ella (401). La sesión sobrevive.
- Arranque con `NODE_ENV=production` y fallo limpio sin `MESSAGE_ENCRYPTION_KEY`.
