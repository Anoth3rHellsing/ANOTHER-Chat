// Post-codegen fix: orval generates lib/api-zod/src/index.ts with both
// generated/api and generated/types re-exports, causing TS2308 collisions.
// Also patches zod.looseObject (Zod v4) → zod.record(zod.unknown()) (Zod v3).
// Also patches zod.instanceof(File|Blob) → zod.any() (not available in Node TSConfig).
import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fix 1: barrel re-export collision
const target = path.resolve(__dirname, '../api-zod/src/index.ts');
writeFileSync(
  target,
  `// Auto-fixed by fix-zod-barrel.mjs after orval codegen.
// Only Zod schemas are exported to avoid TS2308 collisions.
export * from './generated/api';
`
);
console.log('✓ Fixed lib/api-zod/src/index.ts barrel');

// Fix 2: zod.looseObject → zod.record(zod.unknown())
// Fix 3: zod.instanceof(File|Blob) → zod.any()
const apiZodPath = path.resolve(__dirname, '../api-zod/src/generated/api.ts');
let apiZodContent = readFileSync(apiZodPath, 'utf-8');

// Fix looseObject (may be multiline)
apiZodContent = apiZodContent.replace(/zod\.looseObject\(\{[\s\S]*?\}\)/g, 'zod.record(zod.unknown())');
// Fix instanceof File / Blob
apiZodContent = apiZodContent.replace(/zod\.instanceof\(File\)/g, 'zod.any()');
apiZodContent = apiZodContent.replace(/zod\.instanceof\(Blob\)/g, 'zod.any()');

writeFileSync(apiZodPath, apiZodContent, 'utf-8');
console.log('✓ Replaced zod.looseObject → zod.record(zod.unknown())');
console.log('✓ Replaced zod.instanceof(File|Blob) → zod.any()');

// Fix 4: also patch the generated types directory — Blob references
const typesDir = path.resolve(__dirname, '../api-zod/src/generated/types');
try {
  const typeFiles = readdirSync(typesDir).filter(f => f.endsWith('.ts'));
  for (const f of typeFiles) {
    const fp = path.join(typesDir, f);
    let content = readFileSync(fp, 'utf-8');
    const patched = content.replace(/: Blob;/g, ': unknown;').replace(/: File;/g, ': unknown;');
    if (patched !== content) {
      writeFileSync(fp, patched, 'utf-8');
      console.log(`✓ Patched Blob/File in types/${f}`);
    }
  }
} catch {
  // types dir may not exist for all codegen configs
}
