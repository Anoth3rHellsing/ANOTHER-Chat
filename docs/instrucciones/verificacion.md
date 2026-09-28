# Cómo se verifica un PR

La verificación la hace alguien distinto de quien escribió el PR. Todo se **ejecuta**; leer código no es verificar.

## 1. Copia limpia
```bash
git fetch origin pull/<N>/head:pr-<N>
git worktree add ../pr-<N> pr-<N>
cd ../pr-<N>
pnpm install --frozen-lockfile
```

## 2. Comprobaciones estándar (las mismas que el CI)
```bash
pnpm run typecheck
pnpm --filter @workspace/api-server run build
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/another-private run build
DATABASE_URL=postgres://x@127.0.0.1:1/x pnpm --filter @workspace/db run generate   # → "No schema changes"
pnpm --filter @workspace/api-spec run codegen && git status --porcelain lib          # → vacío
pnpm run test:regression
```
`initdb` no se ejecuta como root. En un contenedor como root, lanza la suite con un usuario sin privilegios:
```bash
su pgtest -s /bin/bash -c "cd $PWD && PATH=/usr/lib/postgresql/16/bin:$PATH pnpm run test:regression"
```

## 3. Mira que las pruebas nuevas se ejecutan de verdad
- Un archivo `*-isolated.mjs` nuevo **no se ejecuta** hasta que se añade a la lista de `regression-suite.test.mjs`. Compara el número total de comprobaciones antes y después (pasó con el #4).
- Las acciones positivas no las puede hacer el administrador global, porque se salta los permisos (pasó con el #7).
- Los IDs no pueden coincidir: usuario ≠ servidor ≠ canal, con `assert.notEqual`. Si coinciden, crea un recurso dedicado (pasó con el #1 y con el #7).

## 4. Mutaciones
Por cada protección que el PR dice añadir:
1. quítala o invierte la condición;
2. ejecuta solo ese escenario (`REGRESSION_ONLY=<nombre> pnpm run test:regression`) o la prueba de navegador;
3. **tiene que fallar** por el motivo esperado;
4. restaura el código.

Si una mutación pasa, la prueba no protege nada: el veredicto es «cambios necesarios».

## 5. Interfaz
- Pruebas de navegador en [`pruebas-de-navegador.md`](pruebas-de-navegador.md).
- Revisa las capturas a ojo: una prueba en verde no garantiza que se vea bien.
- Móvil: sin desbordamiento horizontal, zonas táctiles de 44 px, colgar y expandir sin tapar.

## 6. Informe
Como revisión en el PR:
- veredicto;
- tabla de comprobaciones marcando cada una como real, sintética o no verificada;
- tabla de mutaciones;
- bloqueantes, recomendados y lo que queda sin verificar.
