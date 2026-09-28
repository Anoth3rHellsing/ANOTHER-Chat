# Flujo de trabajo

## Papeles
| Quién | Hace | No hace |
|---|---|---|
| **Colaborador** (Manu u otro, o un agente de IA) | Implementa un PR por tema siguiendo [`AGENTS.md`](../../AGENTS.md) y el plan, y rellena la plantilla del PR con las salidas reales | Fusionar su propio PR; tocar Replit, secretos o la base de producción |
| **Claude** (verificación) | Descarga el PR, ejecuta todo desde cero, repite las mutaciones, prueba en el navegador y deja un informe en el PR con veredicto | Fusionar; aprobar lo que no ha ejecutado |
| **Nico** (propietario) | Toma las decisiones marcadas en los planes, aprueba y fusiona, y lleva `main` a Replit | — |

## Ciclo de un PR
1. Rama `fix/…`, `feat/…`, `chore/…` o `docs/…` desde `main`, **un solo tema**.
2. Contrato → codegen → servidor → cliente (`AGENTS.md` §5).
3. Pruebas: actor no administrador, IDs que no coinciden y un recurso de otro servidor. En la interfaz, además, prueba de navegador a 1280 y 390 px.
4. Mutación: romper a propósito lo que se arregló y comprobar que la prueba falla.
5. PR con la plantilla rellena y las salidas reales pegadas.
6. CI en verde (obligatorio).
7. Verificación independiente con el veredicto **listo para merge**, **cambios necesarios** o **bloqueado**.
8. Nico fusiona.

## PR apilados
Si un PR depende de otro que no se ha fusionado, la rama sale de la del anterior y **el PR apunta a `main`**, con una nota «Fusionar después del #N». Nunca se apunta un PR a la rama de otro PR: si esa rama se fusiona antes, el segundo PR queda fusionado en una rama muerta (pasó con el #3).

## Llevar a producción (Replit)
GitHub **no** se sincroniza con Replit.
1. Replit → pestaña Git: comprobar que no hay cambios locales sin subir.
2. Traer `main` (pull). No se lo pidas al agente de Replit: gasta créditos y puede «arreglar» cosas por su cuenta.
3. Ejecutar `pnpm run test:regression` en la shell de Replit.
4. Publicar, y comprobar en el registro que las migraciones se aplicaron.
5. Prueba manual corta: entrar, escribir, una llamada, y en el móvil colgar desde el chat.
