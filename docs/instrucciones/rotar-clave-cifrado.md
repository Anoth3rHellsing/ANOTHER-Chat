# Rotar la clave de cifrado de mensajes

Procedimiento para cambiar `MESSAGE_ENCRYPTION_KEY` sin perder el historial. Lo ejecuta **el propietario**. Ningún agente genera, ve ni recibe la clave nueva.

## Por qué hay que rotarla

Desde el commit `2201f27` (24 de septiembre de 2026), `.replit` guardaba la clave de cifrado en `[userenv.shared]`. El repositorio es **público**, así que la clave debe darse por **comprometida**: quien la tenga y consiga una copia de la base puede leer todos los mensajes.

Quitarla de `.replit` **no la borra del historial de git**: sigue en los commits antiguos, en los clones y en las bifurcaciones. Lo único que protege los datos es cifrarlos con una clave nueva que nunca haya salido de los secretos.

Recuerda (AGENTS.md §7.5): el cifrado es **en reposo**, no de extremo a extremo. El servidor descifra.

## Qué hace la herramienta

`artifacts/api-server/src/scripts/recifrar-mensajes.ts` recorre las tres columnas cifradas:

| Tabla | Columna |
|---|---|
| `messages` | `content_encrypted` |
| `direct_messages` | `content_encrypted` |
| `dm_group_messages` | `content` |

Por cada fila:

- **Ya descifra con la clave nueva** (formato `gcm:v1`): se salta. Por eso se puede repetir y reanudar.
- **Descifra con la antigua** (`gcm:v1` o CBC heredado): se vuelve a cifrar con la nueva en `gcm:v1`. Antes de escribir, comprueba que lo nuevo descifra y da el mismo texto.
- **No descifra con ninguna**: se anota por tabla e id y **se deja intacta**. Nunca se sobrescribe.

Otros detalles:

- Sin `--aplicar` solo cuenta y no escribe nada. La transacción es de solo lectura.
- Trabaja por lotes de 200 filas, cada uno en su transacción. Si algo falla, el lote se deshace y basta con volver a lanzarla. El tamaño se cambia con `RECIFRADO_LOTE` (de 1 a 1000).
- Exige `OLD_MESSAGE_ENCRYPTION_KEY` y `MESSAGE_ENCRYPTION_KEY`: 64 caracteres hexadecimales cada una y distintas. No hay valor por defecto.
- Nunca escribe texto en claro ni claves en la salida.

Al terminar imprime una línea `RESUMEN {…}` con los totales por tabla. El código de salida significa:

| Código | Significado |
|---|---|
| `0` | Todo correcto |
| `1` | Configuración inválida o proceso abortado. El lote en curso se deshizo |
| `2` | Hay filas que no descifran con ninguna clave. Se dejaron intactas y aparecen como `FILA SIN DESCIFRAR <tabla> id=<id>` |

La suite de regresión la prueba en `artifacts/api-server/tests/recifrar-mensajes-isolated.mjs`.

## Antes de empezar

- La plataforma está **parada**: nadie escribe mensajes mientras se rota. Si el servidor siguiera con la clave antigua, cifraría mensajes nuevos con ella.
- Necesitas el código de esta rama **en Replit**. GitHub no despliega nada por sí solo.
- La **base de desarrollo** también está cifrada con la clave filtrada. Rótala igual, con una clave **distinta** de la de producción.

## 1. Generar la clave nueva, en tu equipo

```bash
openssl rand -hex 32
```

- Guárdala en tu gestor de contraseñas.
- **Nunca** la pegues en un chat (tampoco con un agente), en el repositorio, en un issue o PR, en `.replit` ni en una variable `VITE_*`.
- Genera una para producción y otra para desarrollo.

## 2. Copia de seguridad

Antes de tocar nada, haz una copia de la base de producción:

```bash
pg_dump "$DATABASE_URL" -Fc -f another-antes-de-rotar.dump
```

- Guárdala **fuera del repositorio** y en un sitio cifrado.
- Sus mensajes están cifrados con la clave filtrada: trátala con la misma sensibilidad que el texto en claro.
- Comprueba que se puede leer: `pg_restore --list another-antes-de-rotar.dump | head`.

## 3. Ensayo en una COPIA

Restaura la copia en una base temporal que no sea la de producción:

```bash
createdb rotacion_ensayo
pg_restore --no-owner -d rotacion_ensayo another-antes-de-rotar.dump
```

Compila la herramienta y mete las claves sin que queden en el historial de la terminal (`read -rs` no las muestra):

```bash
pnpm --filter @workspace/api-server run build

read -rs OLD_MESSAGE_ENCRYPTION_KEY && export OLD_MESSAGE_ENCRYPTION_KEY   # pega la clave antigua
read -rs MESSAGE_ENCRYPTION_KEY && export MESSAGE_ENCRYPTION_KEY           # pega la clave nueva
export DATABASE_URL="postgres://…/rotacion_ensayo"                          # la COPIA

node artifacts/api-server/dist/scripts/recifrar-mensajes.mjs              # simulación
node artifacts/api-server/dist/scripts/recifrar-mensajes.mjs --aplicar    # escribe en la copia
node artifacts/api-server/dist/scripts/recifrar-mensajes.mjs --aplicar    # repetir: "recifradas":0
```

Lo esperado:

- La simulación cuenta como `pendientes` todo el historial y no cambia nada.
- `--aplicar` las cuenta como `recifradas`.
- La segunda pasada da `recifradas: 0` y lo cuenta todo como `yaConClaveNueva`.

Si hay filas en `fallidas`, apunta sus ids. Casi seguro ya eran ilegibles con la clave antigua (el servidor las mostraría como error). Revísalas antes de seguir: la herramienta no las toca.

Arranca un servidor contra la copia con la clave nueva y abre varios canales, mensajes directos y grupos, incluidos mensajes antiguos.

## 4. Producción

Con la plataforma parada, repite el paso 3 contra la base de producción: simulación, `--aplicar` y una segunda pasada que no cambie nada. Usa las mismas claves y cambia solo `DATABASE_URL`.

Si se corta a medias, vuelve a lanzarla. Las filas ya rotadas se saltan.

## 5. Poner la clave nueva en el servidor

- **Replit:** guarda `MESSAGE_ENCRYPTION_KEY` en **Secrets** del espacio de trabajo y en los secretos de la **publicación**. No uses el panel de *Environment variables*: escribe en `.replit`, que está versionado, y así se filtró la primera vez. Comprueba que `.replit` no vuelve a tener la clave antes de cada commit.
- **Cloudflare u otro proveedor**, si se migra: guárdala como secreto del proveedor (en Cloudflare, `wrangler secret put MESSAGE_ENCRYPTION_KEY` o el panel). Nunca va en `wrangler.toml` ni en ningún archivo del repositorio. Para Coolify, consulta [`../despliegue/coolify.md`](../despliegue/coolify.md).

Después, reinicia o vuelve a publicar.

## 6. Verificar una muestra

- Entra y abre canales, mensajes directos y grupos, con mensajes de antes y de después de la rotación.
- Busca un texto antiguo: la búsqueda descifra al vuelo.
- En los logs del servidor no debe aparecer `Failed to decrypt encrypted message`.

## 7. Destruir la clave antigua

Cuando la producción lleve unos días funcionando con la clave nueva:

- Borra la clave antigua de tu gestor de contraseñas, de Replit (secretos y variables de entorno) y de cualquier terminal (`unset OLD_MESSAGE_ENCRYPTION_KEY`).
- Decide qué haces con la copia del paso 2. Solo se lee con la clave antigua, y esa clave es pública: o se borra, o se guarda sabiendo que equivale a texto en claro.
- Borra la base de ensayo: `dropdb rotacion_ensayo`.

## El historial de git

La clave antigua seguirá en el historial público aunque ya no esté en `.replit`. Hay dos medidas posibles, y ambas son **decisión del propietario**:

- **Hacer el repositorio privado.** No borra los clones ni las bifurcaciones que ya existan.
- **Reescribir el historial** (por ejemplo, con `git filter-repo`) y forzar la subida. Rompe los clones y los PR abiertos. GitHub puede seguir sirviendo commits antiguos desde su caché: para purgarla hay que pedírselo a su soporte.

Ninguna sustituye a la rotación. Con la clave rotada, la antigua ya no descifra nada de la base.
