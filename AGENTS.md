# AGENTS.md — Reglas obligatorias para cualquier agente

Este archivo gobierna el trabajo de **cualquier agente** en este repositorio: Claude Code, el agente de Replit, Codex, Cursor o el que sea. Si trabajas aquí, lo lees entero antes de tocar nada.

**Prioridad:** las instrucciones explícitas del propietario en la conversación actual mandan. Después, este archivo. Después, `replit.md`. Si una instrucción del propietario contradice una regla marcada como **innegociable**, no la ignores en silencio: señala el conflicto y pregunta.

Cada regla existe porque algo se rompió. La sección [Historial de incidentes](#16-historial-de-incidentes) explica cuál.

---

## 0. Resumen en diez líneas

1. Nada está terminado hasta que pasan `pnpm install --frozen-lockfile`, `pnpm run typecheck` y `pnpm run test:regression`, **y pegas su salida**.
2. Las migraciones se **generan** con `drizzle-kit generate`; nunca se escriben a mano. Una segunda generación debe decir *No schema changes*.
3. La API cambia primero en `lib/api-spec/openapi.yaml` y después se ejecuta el codegen.
4. Un pull request por tema. Nada de "fases" agrupadas.
5. Cambios de permisos, límites o políticas: pull request propio y aprobación explícita del propietario.
6. Todo identificador que llega del cliente se valida contra el servidor, canal o usuario al que debe pertenecer.
7. Las pruebas de autorización usan un actor **no administrador** con identificadores que **no coinciden** con los del recurso.
8. Una prueba nueva debe **fallar** con el fallo reintroducido. Si no falla, no protege nada.
9. No fusionas tu propio pull request. Nunca.
10. Si dices "verificado", indicas **cómo**: real, sintético o no verificado.

---

## 1. Qué es este proyecto

**A.N.O.T.H.E.R. Private**: chat privado por invitación, estilo Discord, para un grupo pequeño de confianza. Interfaz en español, siempre oscura, tema AeroNight.

| Área | Tecnología |
|---|---|
| Monorepo | pnpm workspaces, Node.js 24, TypeScript 5.9 |
| Frontend | React 19, Vite, Wouter, Tailwind 4, TanStack Query, Framer Motion |
| API | Express 5, `ws`, express-session con almacén en PostgreSQL |
| Base de datos | PostgreSQL 16, Drizzle ORM, migraciones versionadas |
| Contrato | OpenAPI 3.1 en `lib/api-spec/openapi.yaml`, cliente generado con Orval |
| Validación | Zod (`zod/v4`) desde el catálogo del workspace |
| Tiempo real | Una conexión WebSocket por pestaña, multiplexada |
| Voz y vídeo | WebRTC punto a punto, solo STUN |

### Dónde vive cada cosa

| Ruta | Contenido |
|---|---|
| `lib/db/src/schema/` | Esquema Drizzle, un módulo por dominio |
| `lib/db/drizzle/` | Migraciones SQL generadas, instantáneas en `meta/` |
| `lib/api-spec/openapi.yaml` | **Fuente única de verdad** del contrato de la API |
| `lib/api-zod/`, `lib/api-client-react/src/generated/` | Código **generado**; no se edita a mano |
| `lib/api-client-react/src/csrf.ts` | `csrfFetch` para peticiones fuera del cliente generado |
| `artifacts/api-server/src/app.ts` | Orden de middleware: proxy, helmet, CORS, sesión, CSRF, límites de tasa, entrega de archivos |
| `artifacts/api-server/src/middleware/` | CSRF, límites de tasa, autorización de archivos, errores |
| `artifacts/api-server/src/lib/websocket.ts` | Servidor WebSocket, pertenencia a voz, señalización dirigida |
| `artifacts/api-server/src/lib/permissions.ts` | `getMemberPermissions`, `getMembership`, `canAccessChannel` |
| `artifacts/api-server/src/lib/crypto.ts` | Cifrado AES-256-GCM de mensajes |
| `artifacts/api-server/tests/` | Suite de regresión |
| `artifacts/another-private/src/providers/realtime-transport.tsx` | La única conexión WebSocket del cliente |
| `artifacts/another-private/src/hooks/use-webrtc.ts` | Negociación de voz, pantalla y cámara |
| `artifacts/another-private/src/components/remote-audio.tsx` | Elementos de audio remotos estables |
| `artifacts/another-private/src/lib/microphone-processor.ts` | Supresión de ruido RNNoise |
| `BACKLOG.md` | Trabajo pendiente conocido |

### Entornos — lee esto antes de suponer nada

| Entorno | Qué es | Base de datos |
|---|---|---|
| **Replit, desarrollo** | Donde corre el código de trabajo | Propia |
| **Replit, producción** | Lo que usan los amigos del propietario | **Distinta**, nació como copia |
| **GitHub** | Rama de pre-desarrollo | Ninguna |

**GitHub no se sincroniza solo con Replit.** Fusionar un pull request en GitHub **no despliega nada** ni cambia el código que corre. Si tu cambio tiene que ejecutarse, dilo explícitamente: *"esto está en GitHub; para que corra hay que llevarlo a Replit"*.

---

## 2. Definición de "terminado" — innegociable

Una tarea está terminada solo cuando **todo** esto se cumple y la salida está pegada en el pull request o en el informe:

```bash
pnpm install --frozen-lockfile        # el lockfile coincide con los package.json
pnpm run typecheck                    # cero errores en todo el monorepo
pnpm --filter @workspace/api-server run build
pnpm run test:regression              # la suite completa, no un escenario suelto
```

Y además, **si aplica**:

```bash
# si tocaste el esquema de base de datos
DATABASE_URL=postgres://x@127.0.0.1:1/x pnpm --filter @workspace/db run generate
# → debe responder "No schema changes, nothing to migrate"
#   y `git status lib/db/drizzle` debe estar limpio

# si tocaste openapi.yaml
pnpm --filter @workspace/api-spec run codegen
# → `git status lib/` limpio tras ejecutarlo dos veces seguidas

# si tocaste el frontend
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/another-private run build
```

### Honestidad sobre la verificación

Clasifica cada comprobación en una de tres categorías y **dilo**:

- **Real**: ejecutada contra el sistema de verdad (compilador, PostgreSQL real, navegador real).
- **Sintética**: con datos, fuentes o respuestas simuladas.
- **No verificada**: implementada pero sin comprobar.

Prohibido escribir "verificado" a secas. Prohibido declarar un flujo de "revisión adversarial" o equivalente si nadie ejecutó el compilador ni las pruebas. **Leer código no es verificarlo.**

Cuando midas algo, mide la salida real y no el valor que el sistema declara. Un reproductor que informa `volume: 60` mientras la salida de audio es cero es un caso real de este proyecto.

Una sección *Testing* con instrucciones para que un humano pruebe **no** sustituye a que tú pruebes.

---

## 3. Flujo de trabajo

### Un tema por pull request

- **Un pull request, un propósito.** Si tu descripción necesita "Fase 1… Fase 5", son cinco pull requests.
- Correcciones de fallos, funciones nuevas, refactorizaciones y **cambios de política** nunca van mezclados.
- Rama con nombre descriptivo: `fix/…`, `feat/…`, `chore/…`, `docs/…`.
- Commits pequeños con mensajes que expliquen **por qué**, no solo qué.

### Revisión

- **No fusionas tu propio pull request.** Ni aunque tengas permiso, ni aunque "esté claro".
- No haces `push --force` sobre `main`. No reescribes historial compartido sin autorización explícita.
- El pull request debe poder revisarse. Si pasa de unas 400 líneas de código escrito a mano (sin contar código generado, instantáneas ni lockfile), divídelo.

### Cuándo detenerte y preguntar

Detente, informa y **no sigas** cuando:

- El árbol de trabajo no corresponde al estado que esperabas (otra rama, desincronizado).
- La única forma de avanzar sea escribir en una base de datos con datos reales.
- Una migración generada contenga `DROP`, un renombrado o algo que no esperabas.
- Necesites relajar un permiso, un límite o una comprobación de seguridad.
- Vayas a borrar datos o archivos del propietario o de sus usuarios.
- Una instrucción contradiga una regla innegociable de este archivo.

Es mejor un informe que diga *"me detuve aquí por esto"* que un cambio irreversible hecho por suposición.

### Alcance

- Haz **lo que se pidió**, no más. Si ves otro problema, **repórtalo** en lugar de arreglarlo por tu cuenta, salvo que sea trivial y del mismo archivo.
- **Nada de andamiaje sin usar "para después".** Código que ninguna ruta invoca añade dependencias, superficie de fallo y peso de instalación a cambio de nada. Si hace falta más adelante, se escribe más adelante.

---

## 4. Base de datos y migraciones — innegociable

### Procedimiento

1. Cambia el esquema en `lib/db/src/schema/`.
2. Genera: `pnpm --filter @workspace/db run generate` (necesita un `DATABASE_URL` cualquiera, no se conecta).
3. **Lee el SQL generado.** Si contiene `DROP`, renombrados o cambios que no esperabas, **detente**.
4. Genera **otra vez**: debe responder *No schema changes*.
5. Aplica la cadena completa sobre una **base vacía y temporal** y comprueba el esquema resultante. La suite de regresión ya lo hace en cada escenario.
6. Sube juntos el SQL, la instantánea de `meta/` y la entrada de `_journal.json`.

### Prohibido

- **Escribir migraciones SQL a mano.** Sin instantánea, la siguiente generación intentará recrear lo que ya existe.
- **Editar `_journal.json` a mano** o inventar marcas de tiempo.
- Crear en SQL objetos (índices, restricciones, columnas) que **no estén declarados en el esquema**. La base y el código deben describir lo mismo.
- `drizzle-kit push` o `push-force` contra cualquier base con datos reales.
- Escribir en la base de **producción**. Replit lo restringe; no intentes rodearlo.
- Borrar filas del propietario o de sus usuarios sin autorización explícita.

### Si ya se aplicó una migración defectuosa

No la "arregles" regenerando: las bases que la tienen registrada chocarían. Genera la cadena correcta y **reconcilia** la tabla `drizzle.__drizzle_migrations`, probándolo primero en una copia temporal del estado migrado. Si no puedes escribir en esa base, entrega al propietario los pasos exactos.

### Integridad referencial

Toda relación nueva lleva su clave foránea con la acción de borrado adecuada (`cascade`, `set null`). Hay deudas conocidas: mensajes de canal, pertenencia y propiedad de servidores no tienen clave foránea hacia usuarios (ver `BACKLOG.md`). No añadas más.

---

## 5. Contrato de la API y codegen — innegociable

- `lib/api-spec/openapi.yaml` es la **fuente única de verdad**.
- Orden obligatorio: **1)** contrato, **2)** `pnpm --filter @workspace/api-spec run codegen`, **3)** servidor, **4)** cliente.
- Si el servidor devuelve un campo, el esquema de respuesta lo declara. Si el cliente lo envía, el esquema de entrada lo declara.
- Nunca edites a mano `lib/api-zod/` ni `lib/api-client-react/src/generated/`.
- El contrato usa `nullable: true` para campos anulables. Sigue esa convención.
- Deuda conocida: subidas, amigos, moderación, historias y clips no están en el contrato. No la agraves.

---

## 6. Dependencias e instalación — innegociable

- **Añadir una dependencia implica regenerar y subir `pnpm-lock.yaml`** en el mismo commit. Sin eso, `pnpm install --frozen-lockfile` falla con `ERR_PNPM_OUTDATED_LOCKFILE` y el despliegue se rompe.
- **Declara lo que importas.** Si un paquete usa `zod`, su `package.json` debe listar `zod`. Que funcione por estar instalado en otro paquete del monorepo es un accidente.
- Usa el **catálogo** del workspace (`"zod": "catalog:"`) para dependencias compartidas.
- **No desactives `minimumReleaseAge`** en `pnpm-workspace.yaml`. Es la defensa contra ataques a la cadena de suministro. Si necesitas una versión recién publicada, pregunta.
- **No dependas de binarios del sistema** (`ffprobe`, `ffmpeg`, `imagemagick`…). No existen en el contenedor de producción y el fallo aparece justo al publicar. Usa librerías en JavaScript puro que se empaqueten con esbuild.
- Toda dependencia nueva se justifica en el pull request: qué hace, por qué no basta con lo existente, cuánto pesa.
- Usa `pnpm`, nunca `npm install` ni `yarn`. El `preinstall` lo bloquea.

---

## 7. Seguridad — invariantes que no se tocan

Relajar cualquiera de estas reglas requiere pull request propio y aprobación explícita del propietario.

### 7.1 Autorización y permisos

- La firma es **`getMemberPermissions(serverId, userId)`** y **`getMembership(serverId, userId)`**. **Servidor primero.** Invertirlos ya ocurrió: devuelve prohibido a casi todos y concede permisos de otro servidor cuando los identificadores coinciden.
- Los administradores globales **se saltan** las comprobaciones de permisos. Probar con un administrador no demuestra nada sobre los permisos.
- El acceso a un canal se decide con `canAccessChannel`, que respeta los roles restringidos.

### 7.2 Pertenencia de identificadores — regla general

**Todo identificador que llega del cliente se valida contra el recurso al que debe pertenecer.** `categoryId` pertenece al servidor del canal. `attachmentId` pertenece a quien lo subió y a ese canal. `clipId` pertenece al servidor de la llamada. Si no lo compruebas, un usuario con permiso en el servidor A manipula el servidor B.

### 7.3 Protección contra falsificación (CSRF)

- Toda petición que modifica estado lleva la cabecera del testigo. Se consigue usando el **cliente generado** o **`csrfFetch`** de `@workspace/api-client-react`. **Nunca `fetch` a secas** para escribir.
- Las únicas exenciones son `/api/auth/login`, `/api/auth/register` y `/api/healthz`. No añadas más.

### 7.4 Entrega de archivos

- **Cada petición de archivo reautoriza**: sesión, existencia del registro y permiso **actual** sobre el recurso. Conocer la dirección nunca es una credencial.
- Nunca sirvas subidas con `express.static`.
- Se conservan siempre `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'` y la descarga forzada para tipos no seguros.
- Política de caché por sensibilidad:

  | Recurso | Cache-Control |
  |---|---|
  | Adjuntos de mensajes, historias, biblioteca de archivos | `private, no-store` |
  | Avatares, banners, iconos de servidor | `private, max-age=180, must-revalidate` |
  | Clips y audio del soundboard | `private, max-age=60, must-revalidate` |

- Una revalidación condicional (`304`) también reautoriza.

### 7.5 Cifrado de mensajes

- `MESSAGE_ENCRYPTION_KEY` es obligatoria: 64 caracteres hexadecimales. **Sin ella el servidor no arranca, y así debe seguir.** Nunca añadas una clave de respaldo.
- Formato: `gcm:v1:<cifrado-hex>:<etiqueta-hex>` con IV de 12 bytes.
- **Nunca sobrescribas una fila que no se pudo descifrar.** Se registra y se deja intacta.
- Nunca registres texto en claro en los logs.
- Perder o cambiar la clave de producción deja ilegible todo el historial. No la rotes sin un plan de recifrado aprobado.
- El cifrado es en reposo, **no de extremo a extremo**: el servidor descifra. No lo describas de otra forma.

### 7.6 Perímetro

No relajes nada de esto:

- `app.set("trust proxy", 1)`: exactamente un salto.
- `helmet`.
- CORS: mismo origen, `APP_URL` y localhost solo fuera de producción.
- Cookie de sesión `httpOnly` y `sameSite: "lax"`.
- Límites de tasa en acceso, registro, invitaciones y mensajes.
- Manejador de errores central que no filtra trazas ni errores de la base al cliente.

### 7.7 Secretos y privacidad

- Nunca subas secretos, `.env` ni claves al repositorio.
- Las variables `VITE_*` **son públicas** en el cliente compilado. Nunca pongas credenciales privadas ahí, incluidas las de TURN.
- Las claves de Giphy y VirusTotal solo se usan desde el servidor.
- VirusTotal: análisis **voluntario, por archivo, con consentimiento explícito**. Nunca automático. Un análisis incompleto nunca se presenta como limpio.
- **No subas contenido de los usuarios al repositorio.** Las carpetas `artifacts/api-server/uploads/` y `artifacts/api-server/private-channel-files/` contienen archivos reales. Nota: parte de ese contenido ya está versionado por error. **No hagas `git rm` de esas carpetas**: al sincronizar con Replit borraría los archivos reales del disco.

---

## 8. Tiempo real (WebSocket)

- **Una sola conexión por pestaña**, gestionada por `RealtimeTransportProvider`. No abras conexiones nuevas ni sondees el servidor periódicamente.
- Las suscripciones llevan recuento de referencias y se restauran al reconectar.
- La identidad se resuelve **antes** de procesar mensajes. Los que llegan antes se encolan (máximo 100 mensajes o 1 MB).
- **Pertenencia a voz por conexión**, no por usuario. Tras entrar a un canal de voz, el cliente envía `voice:bind`.
- **Al reconectar hay que restaurar el vínculo de voz**, no solo las suscripciones. Olvidarlo dejó a usuarios "en llamada" pero invisibles.
- **Dos modos de entrega:**
  - **Difusión** a todas las conexiones del usuario: chat, escritura, presencia, menciones, eventos de voz.
  - **Dirigida** a una conexión concreta: señalización WebRTC de voz y de llamadas directas. **Nunca difundas señalización**: duplica ofertas y rompe la negociación.
- **Keepalive:** ping cada 15 s y plazo de pong de 45 s. El plazo se arma **solo si no hay uno pendiente** y lo cancela el pong. Si cada ping lo reiniciara, nunca vencería.
- Las funciones que usa la limpieza de un efecto se definen en el ámbito del efecto, no dentro de funciones anidadas.

---

## 9. Voz, pantalla y medios (WebRTC)

- **Negociación perfecta**: rol determinista por par, reversión ante colisión de ofertas.
- **Cola de candidatos ICE** por par hasta tener la descripción remota.
- Revalida `signalingState` **después** de cada `await`, justo antes de aplicar una descripción.
- **Elementos de audio remotos estables**: se montan una vez y viven fuera de la vista que se oculta al minimizar. **Nunca reasignes `srcObject` en cada render.** Ese fue el motivo de que la voz no se oyera durante meses.
- La detección de voz **no provoca renders** del layout.
- El micrófono y el audio de pantalla son **pistas separadas**. No los mezcles: impide controlar el volumen de cada uno.
- **RNNoise solo en la rama del micrófono**, nunca sobre el audio de pantalla.
- Preferir `replaceTrack` a renegociar.
- **Soundboard**: se envía un aviso por WebSocket y cada cliente reproduce el clip **localmente**. Nunca se mezcla en la pista saliente, para que cada uno pueda silenciarlo.
- **Visionado conjunto**: nadie transmite nada. Cada cliente reproduce con el reproductor oficial incrustado. Prohibido extraer, descargar o reenviar audio de YouTube, SoundCloud o Spotify: lo impiden sus condiciones. La participación es **voluntaria**.
- Solo STUN por defecto. La lista se sustituye con `VITE_ICE_SERVERS`, que es pública.
- Diagnóstico: `VITE_VOICE_DEBUG=true` o `localStorage.setItem('voiceDebug','true')`. Debe quedar **desactivado** en producción.

---

## 10. Frontend e interfaz

- Todo el texto visible está en **español**. Los mensajes de error de la API, también.
- Muestra el **mensaje real** que devuelve la API, no una cadena fija que se enseña ante cualquier fallo.
- Colores solo mediante los **tokens del tema AeroNight**. Nada de hexadecimales sueltos en componentes.
- Los colores de estado (rojo destructivo, verde conectado) se conservan.
- **Comprueba en móvil (unos 390 px de ancho)** todo lo que toques:
  - Ninguna columna de ancho fijo resta espacio a la conversación.
  - Lo que aparece "al pasar el ratón" necesita alternativa táctil.
  - Sin desbordamiento horizontal.
- **Colgar y expandir llamada** están siempre visibles, con cualquier combinación de funciones activas.
- **Widgets de terceros** (YouTube, SoundCloud): React renderiza un contenedor vacío y estable, y el widget vive dentro de forma imperativa. Destrúyelo con su propia API antes de retirar el contenedor. Si no, sale el error *"the node to be removed is not a child of this node"*.
- Los iframes de terceros que reproducen audio necesitan `allow="autoplay"`.
- Un aviso que pide pulsar un botón **tiene que tener ese botón**.

---

## 11. Pruebas

### Cómo ejecutar la suite

```bash
pnpm run test:regression                         # completa, unos 90 s
REGRESSION_ONLY=claims pnpm run test:regression  # un escenario
REGRESSION_REVERSE_ORDER=1 pnpm run test:regression
REGRESSION_EXTENDED=1 pnpm run test:regression   # cobertura ampliada de archivos
```

Requiere PostgreSQL 16 (`initdb`, `pg_ctl`, `createdb`, `psql`) en el `PATH`. **`initdb` se niega a ejecutarse como root**: en un contenedor como root, ejecuta la suite con un usuario sin privilegios.

La suite nunca usa la base de desarrollo, rechaza URLs de base de datos suministradas y bloquea la red salvo loopback. No lo desactives.

### Qué debe cumplir una prueba nueva

- **Actor no administrador.** Los administradores globales se saltan los permisos.
- **Identificadores que no coinciden.** Afírmalo en la propia prueba: `assert.notEqual(memberId, serverId)`. El usuario 1 en el servidor 1 oculta argumentos invertidos.
- **Casos negativos**: alguien de fuera del recurso, alguien sin el permiso, sesión anónima.
- **Recursos cruzados**: un identificador de otro servidor debe rechazarse.
- **Comprobación por mutación.** Reintroduce el fallo a mano y confirma que la prueba falla. Luego restáuralo. Una prueba que pasa con y sin el fallo no protege nada. Este proyecto tuvo una así.

### Cuando cambias una regla

Si cambias un comportamiento deliberadamente, actualizas su prueba **en el mismo commit** para que refleje la regla nueva **y** añades lo que ahora importa comprobar.

**Nunca debilites una prueba para que pase.** Si falla, o el código está mal o la regla cambió a propósito. Averigua cuál.

### Fallos conocidos

Un fallo conocido se registra como tal (ver el caso de horario de verano en `replit.md`) con una forma de hacerlo estricto. Nunca se oculta.

### Registrar la prueba
Un escenario `*-isolated.mjs` nuevo **no se ejecuta** hasta que se añade a la lista de `regression-suite.test.mjs`. Compara el número total de comprobaciones antes y después del PR: si no sube, la prueba no se está ejecutando.

### Pruebas de navegador
Todo cambio de interfaz trae su prueba de Playwright en `scripts/e2e/`: a 1280 px, y a 390 px táctil (`isMobile`, `hasTouch`). Cómo ejecutarlas: [`docs/instrucciones/pruebas-de-navegador.md`](docs/instrucciones/pruebas-de-navegador.md).
- Localiza por papel y nombre accesible o por `data-testid`, nunca por clases.
- Para controles críticos no basta con que sean visibles: comprueba con `elementFromPoint` que **nada los tapa**.
- Termina sin errores de JavaScript (`pageerror`) y sin desbordamiento horizontal.
- Revisa las capturas a ojo. Una prueba en verde no garantiza que se vea bien.
- También se valida por mutación: deshaz el arreglo, recompila y la prueba debe fallar.

### Qué no cubre la suite

Navegador de extremo a extremo, renderizado, proveedores externos reales, datos de producción y negociación WebRTC completa. **Pasar la suite no demuestra que la interfaz funcione.** Si tocaste interfaz, dilo.

---

## 12. Despliegue y operación

- **Máquinas máximas = 1** en la configuración de publicación. El proceso guarda estado en memoria: pertenencia a voz, rutas de llamadas directas, sesiones de visionado, contadores de límites de tasa, enfriamiento del soundboard y caché de vistas previas. Con dos instancias, **el chat se parte en dos**.
- **El disco es efímero.** Avatares, adjuntos, clips, soundboard y biblioteca se pierden en cada redespliegue hasta que se conecte almacenamiento de objetos. La capa de adaptadores existe pero **no la usa ninguna ruta**.
- Secretos de producción necesarios antes del primer arranque: `MESSAGE_ENCRYPTION_KEY`, `SESSION_SECRET`, `APP_URL`. Opcionales: `VirusTotal_Key` o `VIRUSTOTAL_API_KEY`, y la clave de Giphy.
- La base de producción es **distinta** de la de desarrollo. Los datos no viajan entre ellas.
- Publicar no ejecuta las pruebas. Ejecútalas antes.

---

## 13. Estilo de código

- TypeScript estricto. No introduzcas `any` nuevos; hay deuda, no la amplíes.
- Importaciones internas **sin extensión** (`from "../lib/auth"`). La resolución es `bundler`.
- Zod desde `zod/v4`, declarado en el `package.json` del paquete que lo usa.
- Parámetros de ruta numéricos con un parser estricto (`/^[1-9]\d*$/` y `Number.isSafeInteger`), no con `parseInt` suelto.
- Los errores inesperados van al manejador central. Los esperados devuelven su código y un mensaje en español.
- Nada de `catch {}` que se trague errores sin registrarlos.
- Operaciones que deben ser atómicas van en una transacción.
- Reutiliza lo que existe antes de escribir un helper paralelo.

---

## 14. Lista negra

No hagas nunca esto:

- Escribir migraciones o editar `_journal.json` a mano.
- Cambiar la API sin actualizar `openapi.yaml` y regenerar.
- Añadir dependencias sin regenerar el lockfile.
- Depender de binarios del sistema.
- `fetch` sin testigo CSRF para escribir.
- Aceptar un identificador del cliente sin validar a qué pertenece.
- Servir archivos sin reautorizar.
- Añadir una clave de cifrado de respaldo.
- Poner secretos en variables `VITE_*`.
- Difundir señalización WebRTC a todas las conexiones del usuario.
- Reasignar `srcObject` en cada render.
- Mezclar el audio de pantalla o del soundboard en la pista del micrófono.
- Extraer audio de plataformas de terceros.
- Probar permisos con un administrador o con identificadores que coinciden.
- Debilitar una prueba para que pase.
- Agrupar temas sin relación en un pull request.
- Meter un cambio de política dentro de una corrección.
- Añadir código sin usar "para después".
- Fusionar tu propio pull request.
- Escribir o borrar en la base de producción.
- Hacer `git rm` de las carpetas de subidas.
- Desactivar `minimumReleaseAge`.
- Decir "verificado" sin decir cómo.

---

## 15. Formato del informe final

Al terminar, entrega esto:

```markdown
## Qué cambió
- <cambio> — <archivo> — <por qué>

## Decisiones que requieren al propietario
- <permisos, límites, políticas, borrados; o "ninguna">

## Verificación
| Comprobación | Resultado | Tipo |
|---|---|---|
| pnpm install --frozen-lockfile | ok | real |
| pnpm run typecheck | ok | real |
| build del servidor | ok | real |
| drizzle-kit generate | No schema changes | real |
| pnpm run test:regression | N comprobaciones, 0 fallos | real |
| <flujo concreto> | ... | real / sintética / no verificada |

## Comprobación por mutación
- <fallo reintroducido> → <la prueba falla con: …>

## No verificado
- <lo que requiere dos cuentas reales, un navegador o producción>

## Fuera de alcance / encontrado de paso
- <problemas vistos y no tocados>

## Para que corra
- <¿hay que llevarlo a Replit? ¿migraciones? ¿secretos nuevos?>
```

---

## 16. Historial de incidentes

Cada regla de este archivo sale de un fallo real.

| Incidente | Causa | Regla |
|---|---|---|
| La voz no se oía nunca | `srcObject` reasignado cinco veces por segundo; señalización duplicada por tres WebSockets | §8, §9 |
| El registro falló tras endurecer CORS | La lista blanca no incluía el mismo origen del dominio de Replit | §7.6 |
| El error del registro decía "código inválido" siempre | La interfaz descartaba el mensaje real | §10 |
| Adjuntar archivos estaba roto | Identificador centinela `0` contra una clave foránea | §4 |
| El calendario existía pero nadie lo encontraba | Pasaba las comprobaciones y no tenía un acceso visible | §2, §10 |
| Subir al soundboard fallaba siempre | Dependía de `ffprobe`, que no estaba instalado | §6 |
| SoundCloud avanzaba mudo | El iframe no tenía permiso de reproducción; el volumen declarado mentía | §2, §10 |
| La cola de reproducción lanzaba errores | React y el widget se disputaban el mismo nodo | §10 |
| Botón de colgar inaccesible en móvil | Controles en una fila fija que se desbordaba | §10 |
| Usuarios "en llamada" pero invisibles tras desplegar | Al reconectar no se restauraba el vínculo de voz | §8 |
| Archivos de historias caducadas accesibles por su dirección | La entrega no reautorizaba | §7.4 |
| Avatares cargados en cada visita | `no-store` aplicado a todo | §7.4 |
| El pull request #1 no compilaba | Nadie ejecutó `typecheck` antes de fusionar | §2 |
| Instalación estricta rota | SDK añadido sin regenerar el lockfile | §6 |
| Migraciones sin instantánea | Escritas a mano con marcas de tiempo inventadas | §4 |
| Categorías prohibidas para todos salvo el dueño | Argumentos `(userId, serverId)` invertidos, ocultos al probar con el usuario 1 en el servidor 1 | §7.1, §11 |
| Canales colgados de categorías ajenas | `categoryId` sin validar contra el servidor | §7.2 |
| Detección de conexiones muertas inactiva | El plazo de pong se reiniciaba en cada ping | §8 |
| Una prueba nueva no detectaba el fallo que cubría | Los identificadores volvían a coincidir | §11 |
| Cambio de permisos del soundboard sin anunciar | Mezclado en un pull request de "estabilidad" | §3, §14 |
| El PR #3 nunca llegó a `main` | Se apuntó a la rama de otro PR y se fusionó después de que esa rama ya estuviera en `main` | §3 |
| Una prueba nueva nunca se ejecutaba | No estaba en la lista de la suite | §11 |
| Los errores de validación salían en inglés | Zod sin mensajes propios | §10 |
| Las pruebas de un PR solo usaban al administrador global | Se salta los permisos: no demostraban nada | §7.1, §11 |
| En el móvil no se podía colgar desde el chat, y los paneles tapaban el botón | Controles críticos sin prueba en el móvil | §10, §11 |
| Cualquier usuario podía unirse a cualquier servidor sin invitación | Ruta `/servers/:id/join` sin comprobaciones | §7.2 (Fase 0 del plan) |

---

## 17. Mantener este archivo

- Si un fallo nuevo revela una regla que faltaba, **añádela aquí** junto con su fila en el historial.
- Si una regla queda obsoleta, se retira en un pull request propio que explique por qué.
- `CLAUDE.md` importa este archivo y `replit.md` lo referencia. No dupliques reglas en esos archivos: enlázalas.
- El plan de plataforma, los planes por tema y las instrucciones de trabajo viven en [`docs/`](docs/README.md).
- Nunca apuntes un PR a la rama de otro PR. Si depende de uno sin fusionar, sale de su rama pero apunta a `main`, con la nota «Fusionar después del #N».
- `.github/workflows/ci.yml` ejecuta en cada pull request los mismos pasos de §2. Si añades un paso obligatorio aquí, añádelo también al CI y a `.github/pull_request_template.md`.
- Un CI en rojo **bloquea el merge**. No se desactiva ni se salta un paso para que pase: se arregla la causa.
