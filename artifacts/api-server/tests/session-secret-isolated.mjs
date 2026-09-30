// Fase 0.5: en producción, SESSION_SECRET es obligatorio.
// Antes, si faltaba la variable, las sesiones se firmaban con un valor fijo
// que está publicado en el repositorio.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { build } = createRequire(path.join(apiRoot, "package.json"))("esbuild");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "session-secret-"));

try {
  // Se compila el módulo real, sin `define`, igual que en la compilación de producción.
  const outfile = path.join(tempRoot, "session-config.mjs");
  await build({
    entryPoints: [path.join(apiRoot, "src/lib/session-config.ts")],
    platform: "node", bundle: true, format: "esm", outfile, logLevel: "silent",
  });

  function load(env) {
    const clean = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "" };
    return spawnSync(process.execPath, [
      "--input-type=module", "-e",
      `const m = await import(${JSON.stringify(outfile)}); process.stdout.write(m.SESSION_SECRET);`,
    ], { env: { ...clean, ...env }, encoding: "utf8" });
  }

  {
    const result = load({ NODE_ENV: "production" });
    assert.notEqual(result.status, 0, "production without SESSION_SECRET must fail to start");
    assert.match(result.stderr, /SESSION_SECRET is required in production/);
    console.log("PASS production refuses to start without SESSION_SECRET");
  }
  {
    const result = load({ NODE_ENV: "production", SESSION_SECRET: "   " });
    assert.notEqual(result.status, 0, "a blank SESSION_SECRET counts as missing");
    console.log("PASS production refuses a blank SESSION_SECRET");
  }
  {
    const secret = "a".repeat(24) + "-configured-secret";
    const result = load({ NODE_ENV: "production", SESSION_SECRET: secret });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, secret, "production uses the configured secret");
    console.log("PASS production uses the configured SESSION_SECRET");
  }
  {
    const result = load({ NODE_ENV: "development" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length > 0, "development keeps a local fallback");
    console.log("PASS development still starts without SESSION_SECRET");
  }
  console.log("PASS all session secret checks passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
