// Rotación de MESSAGE_ENCRYPTION_KEY (AGENTS.md §7.5) contra un PostgreSQL 16
// desechable: la herramienta src/scripts/recifrar-mensajes.ts vuelve a cifrar
// con la clave B lo cifrado con la A, en las tres tablas cifradas, sin tocar
// las filas que no descifran con ninguna y sin cambiar nada al repetirse.
// Las claves son aleatorias y solo existen durante la prueba.
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startIsolatedApi } from "./helpers/isolated-api.mjs";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { build } = createRequire(path.join(apiRoot, "package.json"))("esbuild");

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const KEY_C = randomBytes(32);
assert.ok(!KEY_A.equals(KEY_B) && !KEY_A.equals(KEY_C) && !KEY_B.equals(KEY_C));

function encryptGcm(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { encrypted: `gcm:v1:${data.toString("hex")}:${cipher.getAuthTag().toString("hex")}`, iv: iv.toString("hex") };
}

function encryptLegacyCbc(plaintext, key) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { encrypted: data.toString("hex"), iv: iv.toString("hex") };
}

/** Descifra un gcm:v1 con `key`; devuelve null si la clave no es la suya. */
function decryptGcm({ encrypted, iv }, key) {
  const parts = encrypted.split(":");
  if (parts.length !== 4 || parts[0] !== "gcm" || parts[1] !== "v1") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(parts[3], "hex"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "hex")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "recifrado-tool-"));
let isolated;
try {
  const banner = `import { createRequire as __r } from "node:module"; globalThis.require = __r(import.meta.url);`;
  const tool = path.join(tempRoot, "recifrar-mensajes.mjs");
  await build({
    entryPoints: [path.join(apiRoot, "src/scripts/recifrar-mensajes.ts")],
    platform: "node", bundle: true, format: "esm", outfile: tool, logLevel: "silent",
    external: ["pg-native"], banner: { js: banner },
  });
  // El módulo que usa el servidor en producción, para comprobar que lee lo rotado.
  const serverCrypto = path.join(tempRoot, "crypto.mjs");
  await build({
    entryPoints: [path.join(apiRoot, "src/lib/crypto.ts")],
    platform: "node", bundle: true, format: "esm", outfile: serverCrypto, logLevel: "silent",
  });

  isolated = await startIsolatedApi("recifrado");
  const { sql, databaseUrl } = isolated;

  function runTool(args, keys) {
    const env = {
      PATH: process.env.PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
      DATABASE_URL: databaseUrl,
      RECIFRADO_LOTE: "2",
      ...keys,
    };
    const result = spawnSync(process.execPath, [tool, ...args], { env, encoding: "utf8" });
    const line = result.stdout.split("\n").find(entry => entry.startsWith("RESUMEN "));
    return { ...result, summary: line ? JSON.parse(line.slice("RESUMEN ".length)) : null };
  }
  const keysAB = { OLD_MESSAGE_ENCRYPTION_KEY: KEY_A.toString("hex"), MESSAGE_ENCRYPTION_KEY: KEY_B.toString("hex") };

  // Datos: usuarios y un grupo; ids desplazados para que no coincidan entre tablas.
  sql(`SELECT setval('messages_id_seq', 100), setval('direct_messages_id_seq', 200), setval('dm_group_messages_id_seq', 300)`);
  const [u1, u2] = sql(`INSERT INTO users (username, password_hash, display_name) VALUES
    ('recifrado_a', 'x', 'A'), ('recifrado_b', 'x', 'B') RETURNING id`).map(Number);
  const [groupId] = sql(`INSERT INTO dm_groups (name, owner_id) VALUES ('grupo', ${u1}) RETURNING id`).map(Number);

  const plaintexts = new Map();
  const expectations = []; // { table, column, id, kind, plaintext? }
  function insert(table, column, extraColumns, extraValues, payload, kind, plaintext) {
    const [id] = sql(`INSERT INTO ${table} (${extraColumns}, ${column}, iv)
      VALUES (${extraValues}, '${payload.encrypted}', '${payload.iv}') RETURNING id`).map(Number);
    expectations.push({ table, column, id, kind, plaintext });
    if (plaintext !== undefined) plaintexts.set(`${table}:${id}`, plaintext);
    return id;
  }
  const channel = ["messages", "content_encrypted", "channel_id, user_id", `7, ${u1}`];
  const direct = ["direct_messages", "content_encrypted", "sender_id, recipient_id", `${u1}, ${u2}`];
  const group = ["dm_group_messages", "content", "group_id, user_id", `${groupId}, ${u2}`];

  const secret = label => `marca-secreta-${label}-${randomBytes(4).toString("hex")} ñandú 🔐`;
  for (const [index, target] of [channel, channel, channel, direct, direct, group, group].entries()) {
    const text = secret(`a${index}`);
    insert(...target, encryptGcm(text, KEY_A), "antigua", text);
  }
  { const text = secret("cbc"); insert(...channel, encryptLegacyCbc(text, KEY_A), "antigua", text); }
  insert(...direct, encryptGcm(" ", KEY_A), "antigua", " ");
  { const text = secret("ya-b"); insert(...group, encryptGcm(text, KEY_B), "nueva", text); }
  const corruptId = insert(...channel, { encrypted: `gcm:v1:${"ab".repeat(12)}:${"00".repeat(16)}`, iv: "11".repeat(12) }, "corrupta");
  const foreignId = insert(...direct, encryptGcm(secret("clave-c"), KEY_C), "corrupta");
  const pendingCount = expectations.filter(row => row.kind === "antigua").length;
  assert.equal(pendingCount, 9);
  assert.notEqual(corruptId, foreignId);

  function snapshot() {
    const rows = {};
    for (const [table, column] of [channel, direct, group]) {
      const [json] = sql(`SELECT coalesce(json_agg(json_build_object('id', id, 'encrypted', ${column}, 'iv', iv) ORDER BY id), '[]') FROM ${table}`);
      for (const row of JSON.parse(json)) rows[`${table}:${row.id}`] = row;
    }
    return rows;
  }
  const before = snapshot();
  assert.equal(Object.keys(before).length, 12);

  // Configuración inválida: no se toca nada.
  {
    const same = runTool(["--aplicar"], { OLD_MESSAGE_ENCRYPTION_KEY: KEY_A.toString("hex"), MESSAGE_ENCRYPTION_KEY: KEY_A.toString("hex").toUpperCase() });
    assert.equal(same.status, 1);
    assert.match(same.stderr, /son iguales/);
    const missing = runTool(["--aplicar"], { MESSAGE_ENCRYPTION_KEY: KEY_B.toString("hex") });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Falta OLD_MESSAGE_ENCRYPTION_KEY/);
    const short = runTool(["--aplicar"], { ...keysAB, MESSAGE_ENCRYPTION_KEY: "ab".repeat(31) });
    assert.equal(short.status, 1);
    assert.match(short.stderr, /MESSAGE_ENCRYPTION_KEY no es válida/);
    const unknown = runTool(["--forzar"], keysAB);
    assert.equal(unknown.status, 1);
    assert.deepEqual(snapshot(), before);
    console.log("PASS the tool refuses equal, missing or malformed keys and unknown flags without touching the database");
  }

  function assertNoLeak(result, label) {
    const output = result.stdout + result.stderr;
    for (const text of plaintexts.values()) {
      if (text.trim()) assert.ok(!output.includes(text), `${label}: plaintext leaked to output`);
    }
    for (const key of [KEY_A, KEY_B, KEY_C]) {
      assert.ok(!output.toLowerCase().includes(key.toString("hex").slice(0, 16)), `${label}: key material leaked to output`);
    }
  }

  // 1) Simulación: cuenta y no escribe.
  {
    const dry = runTool([], keysAB);
    assert.equal(dry.status, 2, `dry run exits 2 because two rows fail\n${dry.stdout}\n${dry.stderr}`);
    assert.equal(dry.summary.modo, "simulacion");
    assert.equal(dry.summary.total.revisadas, 12);
    assert.equal(dry.summary.total.pendientes, 9);
    assert.equal(dry.summary.total.yaConClaveNueva, 1);
    assert.equal(dry.summary.total.fallidas, 2);
    assert.equal(dry.summary.total.recifradas, 0);
    assert.deepEqual(snapshot(), before, "dry run must not change a single byte");
    assertNoLeak(dry, "dry run");
    console.log("PASS dry run counts 9 pending, 1 already rotated and 2 undecryptable rows and writes nothing");
  }

  // 2) --aplicar.
  let afterFirst;
  {
    const applied = runTool(["--aplicar"], keysAB);
    assert.equal(applied.status, 2, `apply exits 2 because two rows fail\n${applied.stdout}\n${applied.stderr}`);
    assert.equal(applied.summary.modo, "aplicar");
    assert.equal(applied.summary.total.recifradas, 9);
    assert.equal(applied.summary.total.fallidas, 2);
    assert.equal(applied.summary.total.yaConClaveNueva, 1);
    assert.equal(applied.summary.porTabla.messages.recifradas, 4);
    assert.equal(applied.summary.porTabla.direct_messages.recifradas, 3);
    assert.equal(applied.summary.porTabla.dm_group_messages.recifradas, 2);
    assert.match(applied.stderr, new RegExp(`messages id=${corruptId}:`));
    assert.match(applied.stderr, new RegExp(`direct_messages id=${foreignId}:`));
    assertNoLeak(applied, "apply");

    afterFirst = snapshot();
    for (const row of expectations) {
      const key = `${row.table}:${row.id}`;
      const now = afterFirst[key];
      if (row.kind === "antigua") {
        assert.notDeepEqual(now, before[key], `${key} was re-encrypted`);
        assert.equal(decryptGcm(now, KEY_B), row.plaintext, `${key} decrypts with the new key to the same plaintext`);
        assert.equal(decryptGcm(now, KEY_A), null, `${key} no longer decrypts with the old key`);
        assert.match(now.iv, /^[0-9a-f]{24}$/, `${key} uses a 12-byte IV`);
      } else {
        assert.deepEqual(now, before[key], `${key} (${row.kind}) stays byte-identical`);
      }
    }
    console.log("PASS --aplicar re-encrypts every old-key row in messages, direct_messages and dm_group_messages with the new key");
    console.log("PASS plaintext is unchanged, the old key no longer decrypts and the legacy CBC row became gcm:v1");
    console.log("PASS undecryptable rows are logged by id and stay byte-identical; already-rotated rows are untouched");
    console.log("PASS neither plaintext nor key material appears in the tool output");
  }

  // 3) El módulo del servidor, con la clave nueva, lee lo rotado.
  {
    const rows = expectations.filter(row => row.kind !== "corrupta").map(row => ({ ...afterFirst[`${row.table}:${row.id}`], expected: row.plaintext }));
    const reader = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { decryptMessage } = await import(${JSON.stringify(serverCrypto)});
      const rows = JSON.parse(process.argv[1]);
      process.stdout.write(String(rows.filter(r => decryptMessage(r.encrypted, r.iv) === r.expected).length));
    `, JSON.stringify(rows)], { env: { PATH: process.env.PATH, MESSAGE_ENCRYPTION_KEY: KEY_B.toString("hex") }, encoding: "utf8" });
    assert.equal(reader.status, 0, reader.stderr);
    assert.equal(Number(reader.stdout), rows.length);
    console.log("PASS the server's crypto module started with the new key decrypts every rotated row");
  }

  // 4) Repetir no cambia nada.
  {
    const again = runTool(["--aplicar"], keysAB);
    assert.equal(again.status, 2);
    assert.equal(again.summary.total.recifradas, 0);
    assert.equal(again.summary.total.pendientes, 0);
    assert.equal(again.summary.total.yaConClaveNueva, 10);
    assert.equal(again.summary.total.fallidas, 2);
    assert.deepEqual(snapshot(), afterFirst, "a second run changes nothing");
    console.log("PASS a second --aplicar run is a no-op (idempotent and resumable)");
  }
  console.log("PASS all key rotation checks passed");
} finally {
  await isolated?.stop();
  await rm(tempRoot, { recursive: true, force: true });
}
