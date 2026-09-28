# Plan: llamadas estables y presencia fiable

**Origen:** revisión del PR #1 (septiembre de 2026). **Estado:** C hecho (#4); presencia resuelta en parte (#6); A1, A2 y B pendientes. A1 y A2 son las fases 3.1 y 3.2 del [plan de plataforma](../plan-paridad-discord.md).

| PR | Tema | Estado |
|---|---|---|
| C | Estado personalizado (SQL roto en `PATCH /users/me`) | ✅ #4 |
| — | «Desconectado» como modo invisible que la presencia automática respeta | ✅ #6 (decisión del equipo: se mantiene la presencia automática) |
| A1 | Registrar por qué se caen las llamadas | Pendiente |
| A2 | Margen de reconexión en voz y en llamadas directas | Pendiente |
| B | Presencia separada: estado elegido frente a calculado | Pendiente (opcional tras #6) |

## A1 — Registrar por qué se caen las llamadas
Nadie ha medido por qué se caen. Con registros se sabrá si es la red, el plazo del pong, los redespliegues u otra cosa.

- En `artifacts/api-server/src/lib/websocket.ts`, con el `logger` existente y nivel `info`:
  - `ws_close`: `userId`, `connectionId`, código de cierre, motivo (máximo 64 caracteres), duración, si estaba autenticada, canales de voz vinculados, si tenía una llamada directa activa y si la cerró el latido del servidor;
  - `voice_leave`: `explicit`, `connection_lost` o `reservation_expired`;
  - `dm_call_end`: `explicit`, `rejected`, `connection_lost`, `expired` o `replaced`.
- Códigos de cierre de referencia: 1000 normal, 1001 la página se fue, 1006 corte de red, 4000 plazo de pong vencido.
- **Prohibido registrar:** contenido de mensajes, SDP, candidatos ICE, IP, cookies o tokens.

## A2 — Margen de reconexión
**Causa probada por lectura del código:** un cierre del WebSocket saca al usuario de la voz y envía `dm:call-end` en el acto, aunque el audio WebRTC, que va de navegador a navegador, suele sobrevivir a un microcorte.

| Situación | Hoy | Con A2 |
|---|---|---|
| Microcorte de menos de 20 s en voz | Todos lo ven salir y se renegocia desde cero | «Reconectando…»; el audio sigue |
| Microcorte de menos de 20 s en llamada directa | La llamada termina | Continúa y se reengancha la señalización |
| Corte de más de 20 s | Igual que arriba | Sale o se cuelga con `connection_lost` |
| Colgar a mano | Inmediato | Inmediato |

**Servidor:**
- `RECONNECT_GRACE_MS = 20_000`, que las pruebas pueden cambiar por variable de entorno.
- Voz: durante el margen se mantiene al usuario, reutilizando el mecanismo de reserva de `joinVoiceChannel`, y se emiten `voice:member_reconnecting`, `voice:member_resumed` o `voice:member_leave`.
- Llamadas directas: la ruta activa queda suspendida. El mensaje `dm:call-resume { peerId }` se valida contra el usuario de la sesión y el lado suspendido; **el `connectionId` nunca viene del cliente**.

**Cliente:**
- Con «reconectando» no se cierra la conexión WebRTC; en la llamada directa se envía `dm:call-resume`.
- Se conservan las conexiones `connected`, y a las que están en `disconnected` se les aplica `restartIce()`.
- No se reasigna `srcObject` (`AGENTS.md` §9).

**Pruebas:**
- Reconectar dentro del margen: sin `member_leave`, y la señalización llega a la conexión nueva.
- Superar el margen: `member_leave` con `connection_lost`.
- Llamada directa reanudada.
- Un tercero que intenta reanudar la llamada es rechazado.
- La prueba actual de desconexión se actualiza en el mismo commit.
- **Mutación:** con margen 0, las pruebas de reanudación fallan.

**Prueba manual:** llamada entre un móvil y un PC; se corta el wifi del móvil 10 s y la llamada no debe caer.

## B — Presencia separada (opcional)
Tras #6 se mantiene la presencia automática y «Desconectado» es invisible. Quedan fallos conocidos, aceptados por el equipo:
- «Ausente» puesto a mano vuelve a «Conectado» con actividad;
- se puede quedar en «No molestar» tras colgar;
- un F5 pasa a «Conectado» a quien tenía «No molestar» manual.

Si se decide arreglarlos, el diseño es:
- columna `preferred_status`, que solo cambia el usuario;
- `status` calculado por el servidor a partir de las conexiones, la inactividad de cada pestaña informada por WebSocket, y si está en llamada;
- un único evento `user:status`.
