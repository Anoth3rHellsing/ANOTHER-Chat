# Auditoría de la interfaz móvil (septiembre de 2026)

**Método:** recorrido automático de 36 pantallas a 390 × 844 px táctil con Chromium y Playwright (`scripts/e2e/audit.mjs`), revisión manual de cada captura y medidas objetivas: desbordamiento horizontal, controles fuera de pantalla, zonas táctiles menores de 32 px y errores de JavaScript.

## Hallazgos y estado

| # | Hallazgo | Gravedad | Estado |
|---|---|---|---|
| 1 | Dentro de un servidor no había forma de volver a la lista de servidores | Alta | ✅ #8 |
| 2 | «Clips» no hacía nada en el móvil (solo se resaltaba) | Alta | ✅ #8 |
| 3 | Con la llamada minimizada, en el chat no había barra de llamada: no se podía colgar ni volver a la llamada | **Crítica** | ✅ #9 |
| 4 | Soundboard y Ajustes de participantes seguían abiertos al minimizar, se apilaban y **tapaban el botón de colgar** | **Crítica** | ✅ #9 |
| 5 | Los `⋮` de mensajes cortos seguidos se solapaban | Media | ✅ #10 |
| 6 | El menú de acciones del mensaje no se cerraba al tocar fuera | Media | ✅ #10 |
| 7 | El panel de Eventos era semitransparente sobre el chat | Media | ✅ #10 |
| 8 | 8 de las 11 pestañas de Configuración del servidor quedaban fuera de pantalla, sin indicación de desplazamiento | Media | ✅ #10 |
| 9 | «Owner» y «manage channels» en inglés | Baja | ✅ #10 |
| 10 | Ayuda de la búsqueda en monoespaciada y pegada a los bordes | Baja | ✅ #10 |
| 11 | Botones de 24–28 px (categorías, volver, ajustes, cerrar Soundboard) | Media | ✅ #8 y #9 |
| 12 | Al entrar en un servidor se aterrizaba en el primer canal de cualquier tipo | Baja | ✅ #8 |
| 13 | Errores de la API de eventos en inglés | Baja | Pendiente (plan, 0.5) |
| 14 | Acciones del registro de auditoría como códigos en inglés | Baja | Pendiente (plan, 4.4) |
| 15 | El propio indicador de estado puede quedarse desactualizado | Baja | Pendiente (plan de presencia, B) |
| 16 | Cabecera de mensajes directos sin atajo a Amigos o Nuevo grupo | Baja | Por revisar |

## Pruebas que protegen estos arreglos
- `scripts/e2e/ui.mjs`: barra de canales, dos cuentas, escritorio y móvil (19 comprobaciones).
- `scripts/e2e/call.mjs`: colgar y expandir visibles y **sin tapar**, comprobado con `elementFromPoint` (9 comprobaciones).
- `scripts/e2e/chat.mjs`: menús de mensaje, Eventos, textos y pestañas (8 comprobaciones).

Cada arreglo se validó por mutación: se deshace a propósito y la prueba debe fallar.

## Qué no cubre
Safari e iOS reales, audio real (se usa un micrófono falso) y la pulsación larga en un teléfono físico.
