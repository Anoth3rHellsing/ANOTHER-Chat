# Plan: gestión y orden de canales

**Estado:** D1 hecho (#7), D2 en revisión (#8), D3 opcional.

## Decisiones tomadas
- **E1:** gestionan canales el dueño, los admins y cualquier rol con *Gestionar canales* (igual que el servidor).
- **E2:** borrado definitivo, escribiendo el nombre del canal para confirmar.
- **E3:** no se puede borrar el último canal de texto (409).
- **E4:** el tipo de un canal no cambia después de crearlo.
- **E5:** primero solo menú (D2); arrastrar y soltar (D3) solo si se queda corto.
- **E6:** no se crean categorías automáticamente.

## D1 — Servidor (hecho, #7)
- Validación Zod con mensajes en español.
- Borrado en una transacción con E3 bloqueando los canales de texto (`FOR UPDATE`); después se borran los archivos del disco, incluidos los adjuntos.
- Quien estaba en un canal de voz borrado sale con `voice:member_leave` y `reason: "channel_deleted"`, con su propio `userId`.
- El evento `channels:changed { serverId }` va solo a los miembros del servidor y no lleva nombres.
- Orden: primero los canales sin categoría, luego por posición de la categoría y después por posición del canal.
- Contrato completo de categorías y reorden.

## D2 — Barra y menú (#8)
- `components/channel-sidebar.tsx`: categorías plegables (lo plegado se guarda por navegador), menú `⋮` y clic derecho por canal y por categoría, y Clips separado.
- Diálogos: editar (nombre, categoría y roles con acceso), eliminar escribiendo el nombre, y crear, renombrar o eliminar categorías.
- Móvil: zonas táctiles de 44 px, volver a la lista de servidores, aterrizar en el primer canal de texto y Clips accesible.
- Prueba de navegador con dos cuentas (19 comprobaciones): `scripts/e2e/ui.mjs`.

## D3 — Arrastrar y soltar (opcional)
- `@dnd-kit/core` y `@dnd-kit/sortable`: arrastre entre categorías, táctil (pulsación larga sobre un asa) y con teclado.
- Reutiliza el mismo `PUT reorder` y la actualización optimista de D2.
