# Trabajo pendiente

Este archivo recoge trabajo pendiente conocido de la auditoría técnica. Debe mantenerse actualizado conforme se complete cada elemento.

## Prioridad alta

- [ ] **Probar la voz entre dos redes físicas con micrófonos reales.** Hasta ahora solo se verificó con dos navegadores en la misma máquina y micrófonos sintéticos. Confirmar la conectividad entre redes y consultar el diagnóstico de voz para identificar la ruta seleccionada. Si necesita retransmisión, decidir entre un proveedor con credenciales o un reenvío de audio propio.
- [ ] **Automatizar las pruebas de regresión.** El proyecto no tiene pruebas automatizadas: las baterías manuales de la auditoría se ejecutaron una vez y se descartaron. Convertirlas en pruebas repetibles evitará tener que verificar a mano todo el sistema tras cada cambio.
- [ ] **Conectar los adaptadores de almacenamiento y migrar los archivos a almacenamiento persistente.** La capa de adaptadores ya existe, pero todavía no está conectada a ninguna ruta; los archivos siguen guardándose en el disco efímero del servidor y pueden perderse al desplegar o escalar.
- [ ] **Confirmar con el propietario los permisos de subida del soundboard.** El cambio actual permite que cualquier miembro del servidor suba clips, en lugar de exigir permiso para administrar canales; mantenerlo pendiente hasta recibir su confirmación.

## Prioridad media

- [ ] **Mostrar un círculo verde alrededor del avatar cuando el usuario esté hablando.** La detección de voz se desacopló deliberadamente del render porque actualizar el estado cinco veces por segundo impedía estabilizar el audio remoto: actualizar solo el avatar afectado, sin volver a renderizar todo el layout. Hoy solo se analiza el audio local; para otros participantes, analizar los flujos remotos que cada cliente ya recibe en vez de anunciar el estado desde el servidor.
- [ ] **Definir e implementar el borrado de cuentas.** Hoy no existe este mecanismo y podría dejar datos huérfanos: los mensajes de canal, la pertenencia a servidores y la propiedad de servidores no tienen claves foráneas hacia usuarios. Añadirlas con acciones apropiadas y decidir qué sucede con el contenido y los servidores cuando se marcha su propietario.
- [ ] **Limpiar los adjuntos huérfanos.** Los archivos subidos que nunca se vinculan a un mensaje conservan indefinidamente su fila y su archivo físico. Programar una limpieza de los no reclamados con cierta antigüedad y revalidar que sigan sin reclamar justo antes de borrarlos.
- [ ] **Completar el contrato de la API.** La especificación declarada como fuente única de verdad omite subidas de archivos, amigos, moderación, historias y clips. Incluirlos para que el contrato refleje lo que la interfaz realmente ofrece.

## Prioridad baja

- [ ] **Dividir el componente principal de la interfaz.** Un archivo de más de mil líneas concentra servidores, canales, mensajes directos, voz, llamadas, modales y subidas; separarlo facilitará su revisión y mantenimiento.
- [ ] **Reducir los tipos sin comprobación en el frontend.** Se usan ampliamente incluso con datos que ya tienen tipos generados; aprovechar esos tipos ayudaría a detectar errores antes de ejecutar la aplicación.
- [ ] **Liberar las referencias de vistas previas de adjuntos.** Se crean referencias a objetos en memoria que nunca se revocan, lo que puede producir una fuga de memoria.
- [ ] **Paginar de verdad el historial de mensajes.** Sin paginación real, los historiales extensos pueden cargar demasiados datos y degradar la experiencia.
- [ ] **Evaluar el rediseño con AeroGlass.** Su especificación es portable, pero está pensada para otra tecnología y la versión web está incrustada en una demostración sin variables reutilizables. Extraerla y reconstruir componentes reutilizables; decidir antes si se migra toda la identidad oscura actual hacia la estética clara del sistema o solo componentes concretos.
- [ ] **Mantener la llamada de voz durante cortes breves de red.** Requiere renegociación coordinada entre cliente y servidor para que la llamada se recupere sin obligar a iniciarla de nuevo.

## Contexto: trabajo ya completado

Se estableció un esquema de base de datos reproducible con migraciones versionadas y se consolidó en una fuente única. Se endureció el perímetro del servidor con cabeceras de seguridad, restricción de orígenes, limitación de tasa y manejo centralizado de errores; se añadió protección contra falsificación de peticiones entre sitios mediante doble envío. El cifrado de mensajes se migró a un modo autenticado con clave obligatoria y se corrigió el modelo de adjuntos. El tiempo real se consolidó en una conexión por pestaña, con identidad por conexión y enrutado dirigido de señalización, y se reparó el subsistema de voz.