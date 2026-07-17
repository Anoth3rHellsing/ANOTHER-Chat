// Post-codegen fix: orval generates lib/api-zod/src/index.ts with both
// generated/api and generated/types re-exports, causing TS2308 collisions
// for params types that exist in both files (e.g. ListMessagesParams).
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(__dirname, '../api-zod/src/index.ts');

writeFileSync(
  target,
  `// Auto-fixed by fix-zod-barrel.mjs after orval codegen.
// Only Zod schemas are exported to avoid TS2308 collisions.
export * from './generated/api';
`
);

console.log('✓ Fixed lib/api-zod/src/index.ts barrel');
