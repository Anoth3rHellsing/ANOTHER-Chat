# Pruebas de navegador (Playwright)

Levantan PostgreSQL desechable, la API compilada y el frontend compilado detrás de un proxy que imita a Replit (`/api` y `/ws` van a la API; el resto, al frontend). Después abren Chromium con cuentas sintéticas.

## Requisitos
- Node 24, pnpm y PostgreSQL 16 (`initdb`, `pg_ctl`, `createdb`) en `/usr/lib/postgresql/16/bin` o en el `PATH`.
- Chromium de Playwright. En un entorno nuevo: `pnpm --filter @workspace/scripts exec playwright install chromium`.
- Si trabajas como root, la base se levanta con un usuario sin privilegios (por defecto `pgtest`; se cambia con `E2E_PG_USER`).

## Uso
```bash
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server run build
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/another-private run build

bash scripts/e2e/restart.sh            # base limpia + API + proxy + datos sintéticos
node scripts/e2e/ui.mjs                # barra de canales: 2 cuentas, escritorio y móvil
bash scripts/e2e/restart.sh && node scripts/e2e/call.mjs   # llamada en el móvil
bash scripts/e2e/restart.sh && node scripts/e2e/chat.mjs   # chat y textos en el móvil
bash scripts/e2e/restart.sh && node scripts/e2e/audit.mjs  # recorrido de 36 pantallas (capturas + medidas)
```
`ui.mjs`, `call.mjs` y `chat.mjs` prueban lo que añaden los PR #8, #9 y #10: hasta que estén en `main`, compila una rama que los contenga y apunta a ella con `E2E_REPO=/ruta/a/esa/copia`.

Variables: `E2E_DIR` (datos y capturas), `E2E_REPO` (código que se levanta), `E2E_BASE` (URL, por defecto `http://127.0.0.1:58000`), `E2E_PG_PORT`, `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_PG_BIN` y `E2E_PG_USER`.

Reinicia entre pruebas: cada una modifica los datos y el límite de intentos de login está en memoria.

Las capturas se guardan en `$E2E_DIR/shots`, y las de la auditoría en `$E2E_DIR/audit` (por defecto `E2E_DIR=/tmp/another-e2e`).

## Datos sintéticos (`seed.mjs`)
| Usuario | Contraseña | Papel |
|---|---|---|
| `dueno` | `Sintetica-12345!` | Primer usuario (admin global), dueño del servidor «Pruebas» |
| `gestor` | igual | Miembro **no administrador** con el rol «Gestores» (*Gestionar canales*) |
| `miembro` | igual | Miembro sin permisos |

Servidor «Pruebas»:
- categorías «Texto» y «Voz»;
- canales `general-texto-1`, `eventos-de-atornillados`, `voz-general-1`, `voice-2`, `archivos` y `borrame`;
- mensajes, un mensaje directo y un evento.

Son datos **ficticios**, solo para la base desechable local. Nunca se usan contra producción.

## Cómo escribir una prueba nueva
- Localiza por papel y nombre accesible (`getByRole('button', { name: 'Colgar llamada' })`) o por `data-testid`. No uses clases CSS.
- En el móvil usa `tap()` y un contexto con `isMobile: true, hasTouch: true`.
- «Visible» no basta: para controles críticos, comprueba que **no están tapados** con `elementFromPoint` en su centro (mira `call.mjs`).
- Termina comprobando que no hubo errores de JavaScript (`pageerror`) y que no hay desbordamiento horizontal.
- Haz la mutación: deshaz el arreglo, recompila y comprueba que la prueba falla.
