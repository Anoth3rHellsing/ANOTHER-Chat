<!-- Lee AGENTS.md antes de abrir este PR. Un PR = un tema. Nadie hace merge de su propio PR. -->

## Qué cambia y por qué

<!-- Una o dos frases. Enlaza el issue o la petición. -->

## Tema único

- [ ] Este PR trata **un solo tema**. No mezcla refactors, dependencias ni cambios de estilo ajenos.

## Checklist obligatoria (AGENTS.md §2)

- [ ] `pnpm install --frozen-lockfile` pasa (si añadí dependencias, `pnpm-lock.yaml` está commiteado y cada import está declarado en su `package.json`).
- [ ] `pnpm run typecheck` pasa.
- [ ] Si toqué `lib/api-spec/openapi.yaml`: ejecuté codegen y commiteé lo generado.
- [ ] Si toqué `lib/db/src/schema`: migración **generada** con `drizzle-kit generate` (SQL + snapshot + journal). Nada escrito a mano, nada de `push`.
- [ ] Builds de API y frontend pasan.
- [ ] `pnpm run test:regression` pasa.
- [ ] Rutas nuevas con permisos: `getMemberPermissions(serverId, userId)` en ese orden; todo ID recibido del cliente se valida contra el servidor/canal del recurso.
- [ ] Test nuevo con actor **no admin** e IDs que **no coinciden** entre sí, y comprobé que **falla** si reintroduzco el bug (prueba de mutación).
- [ ] Sin secretos, sin `.env`, sin archivos de `uploads/` ni `private-channel-files/`.
- [ ] No toqué producción (BD, secretos, deploy).

## Evidencia (pega las salidas reales)

```text
typecheck:
regresión (resumen final):
drizzle-kit generate:
```

## Honestidad

- **Verificado de verdad:** <!-- qué ejecutaste y viste pasar -->
- **Verificado con datos sintéticos:** <!-- -->
- **Sin verificar:** <!-- qué no pudiste probar (voz real, móvil, prod…) y por qué -->

## Riesgos y reversión

<!-- Qué podría romperse y cómo se revierte. -->
