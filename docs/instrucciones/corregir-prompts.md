# Cómo escribir un prompt para un agente de código

Guía para convertir una petición en bruto («arregla la voz», «añade categorías») en un prompt que un agente (Replit Agent, Claude Code, Codex, Cursor) ejecute **una sola vez, bien, sin inventar alcance y demostrando lo que hizo**.

## 0. Antes de escribir
1. **¿Qué agente lo va a ejecutar?**
   - **Replit Agent:** máximo 8.000 caracteres (apunta a 6.000). Lee `replit.md` y **no ve GitHub** hasta que Nico trae la rama.
   - **Claude Code, Codex o Cursor en el repo:** leen `AGENTS.md` y `CLAUDE.md`, así que basta con citar la sección.
   - **Agente sin acceso al repo:** incluye el código o las rutas exactas.
2. **¿Puede ver el código afectado?** Si el cambio está en una rama de GitHub y el destino es Replit, primero hay que traerla.
3. **Diagnostica antes de prescribir.** Pon la causa con archivo y función, marcada como **PROBADA** o como **HIPÓTESIS**.
4. **Un tema por prompt.** Si mezcla temas, escribe varios prompts ordenados.
5. **Las decisiones del propietario no se esconden.** Permisos, políticas, borrados, gastos, dependencias nuevas o cambios visibles se preguntan, o se ponen como condición de parada.

## 1. Estructura
```
## Contexto          (proyecto, rutas exactas, qué secciones de AGENTS.md leer)
## Problema          (síntoma literal; causa PROBADA/HIPÓTESIS con archivo:línea)
## Tarea             (pasos numerados, un solo tema)
## Alcance           (qué se puede tocar y qué no)
## Condiciones de parada (cuándo detenerse y preguntar)
## Verificación      (comandos exactos y el resultado esperado de cada uno)
## Prueba de regresión (actor no admin, IDs distintos, mutación)
## Definición de terminado
## Informe final     (formato de AGENTS.md §15)
```

## 2. Requisitos que casi siempre faltan
- **Dependencias:** todo import declarado en su paquete, lockfile regenerado y `pnpm install --frozen-lockfile` en verde. Sin binarios del sistema.
- **Migraciones:** siempre `drizzle-kit generate` (SQL, instantánea y journal). Una segunda generación debe decir «No schema changes».
- **Permisos:** `getMemberPermissions(serverId, userId)`, con el servidor primero. Todo ID del cliente se valida contra su recurso.
- **Pruebas que de verdad detectan el fallo:** actor no admin, `assert.notEqual` entre IDs, un recurso de otro servidor y mutación.
- **Prueba nueva registrada en la suite**, comparando el total de comprobaciones antes y después.
- **Interfaz:** en español, a 390 px, con controles críticos siempre visibles y prueba de navegador.
- **Mensajes de error con texto propio en español**: la validación de Zod responde en inglés si no se le da.

## 3. El informe que debe devolver el agente
Qué cambió, la verificación con cada comprobación marcada como real, sintética o no verificada, las mutaciones, lo que queda sin verificar, las decisiones para el propietario y lo encontrado de paso. Añade explícitamente: «No digas que algo funciona si no lo ejecutaste. No fusiones.»

## 4. Lista final
- [ ] Un solo tema.
- [ ] El agente puede ver el código.
- [ ] Causa marcada como PROBADA o HIPÓTESIS.
- [ ] Alcance y condiciones de parada.
- [ ] Comandos exactos.
- [ ] Prueba con actor no admin, IDs distintos y mutación.
- [ ] Ningún secreto ni contraseña real.
- [ ] Longitud dentro del límite del agente.
- [ ] Ningún cambio de política sin aprobar.
