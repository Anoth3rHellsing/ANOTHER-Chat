---
name: Codegen barrel fix
description: Orval regenerates lib/api-zod/src/index.ts on each codegen run, re-exporting both generated/api (Zod schemas) and generated/types (TS types), causing TS2308 collision for params like ListMessagesParams.
---

**The rule:** Never edit `lib/api-zod/src/index.ts` directly — orval overwrites it.

**Fix in place:** `lib/api-spec/fix-zod-barrel.mjs` is called in the codegen script AFTER orval runs and BEFORE `typecheck:libs`:
```
"codegen": "orval --config ./orval.config.ts && node fix-zod-barrel.mjs && pnpm -w run typecheck:libs"
```
The script overwrites `lib/api-zod/src/index.ts` with only `export * from './generated/api';`.

**Why:** For operations with both path AND query params (e.g. listMessages with channelId + before + limit), orval generates `ListMessagesParams` as both a Zod schema in `generated/api.ts` AND a TypeScript interface in `generated/types/`. When both are barrel-exported, TypeScript errors TS2308.

**How to apply:** Always run codegen via `pnpm --filter @workspace/api-spec run codegen`, never call orval directly. The fix script runs automatically.
