// Rotación de MESSAGE_ENCRYPTION_KEY: vuelve a cifrar con la clave nueva cada
// mensaje cifrado con la antigua. Procedimiento: docs/instrucciones/rotar-clave-cifrado.md
//
//   OLD_MESSAGE_ENCRYPTION_KEY=… MESSAGE_ENCRYPTION_KEY=… DATABASE_URL=… \
//     node dist/scripts/recifrar-mensajes.mjs            # simulación: solo cuenta
//   … node dist/scripts/recifrar-mensajes.mjs --aplicar  # escribe
//
// Reglas (AGENTS.md §7.5):
// - Las dos claves son obligatorias y distintas. No hay clave de respaldo.
// - Una fila que ya descifra con la clave nueva se salta: se puede repetir y
//   reanudar sin riesgo.
// - Una fila que no descifra con ninguna de las dos se registra por id y se
//   deja intacta. Nunca se sobrescribe.
// - Nunca se escribe texto en claro ni el valor de una clave en la salida.
import { pool } from "@workspace/db";
import {
  decryptMessagePayloadWithKey,
  encryptMessageWithKey,
  isGcmMessage,
  isValidMessageKeyHex,
} from "../lib/message-cipher";

// Todas las columnas cifradas con lib/crypto.ts. Si aparece otra, se añade aquí.
const TABLES = [
  { table: "messages", column: "content_encrypted" },
  { table: "direct_messages", column: "content_encrypted" },
  { table: "dm_group_messages", column: "content" },
] as const;

type Totals = {
  revisadas: number;
  yaConClaveNueva: number;
  pendientes: number;
  recifradas: number;
  fallidas: number;
  cambiadasDuranteElProceso: number;
};

class ConfigError extends Error {}

function emptyTotals(): Totals {
  return {
    revisadas: 0,
    yaConClaveNueva: 0,
    pendientes: 0,
    recifradas: 0,
    fallidas: 0,
    cambiadasDuranteElProceso: 0,
  };
}

function readKey(name: string): Buffer {
  const value = process.env[name];
  if (!value) {
    throw new ConfigError(`Falta ${name}: debe tener exactamente 64 caracteres hexadecimales.`);
  }
  if (!isValidMessageKeyHex(value)) {
    throw new ConfigError(`${name} no es válida: debe tener exactamente 64 caracteres hexadecimales.`);
  }
  return Buffer.from(value, "hex");
}

function readBatchSize(): number {
  const raw = process.env.RECIFRADO_LOTE;
  if (raw === undefined || raw === "") return 200;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 1_000) {
    throw new ConfigError("RECIFRADO_LOTE debe ser un entero entre 1 y 1000.");
  }
  return Number(raw);
}

function parseArgs(argv: string[]): { aplicar: boolean } {
  let aplicar = false;
  for (const arg of argv) {
    if (arg === "--aplicar") aplicar = true;
    else throw new ConfigError(`Argumento desconocido: ${arg}. El único admitido es --aplicar.`);
  }
  return { aplicar };
}

type Row = { id: number; encrypted: string; iv: string };

type Classification =
  | { kind: "nueva" }
  | { kind: "antigua"; plaintext: string }
  | { kind: "fallida" };

function classify(row: Row, oldKey: Buffer, newKey: Buffer): Classification {
  // Solo se da por rotada una fila GCM: la etiqueta de autenticación demuestra
  // la clave. Un CBC antiguo puede «descifrar» con una clave equivocada y dar
  // basura, y la clave nueva nunca escribe CBC.
  if (isGcmMessage(row.encrypted)) {
    try {
      decryptMessagePayloadWithKey(row.encrypted, row.iv, newKey);
      return { kind: "nueva" };
    } catch {
      // No es de la clave nueva; se prueba con la antigua.
    }
  }
  try {
    const { plaintext } = decryptMessagePayloadWithKey(row.encrypted, row.iv, oldKey);
    return { kind: "antigua", plaintext };
  } catch {
    return { kind: "fallida" };
  }
}

async function rotateTable(
  target: typeof TABLES[number],
  keys: { oldKey: Buffer; newKey: Buffer },
  options: { aplicar: boolean; batchSize: number },
): Promise<Totals> {
  const totals = emptyTotals();
  let lastId = 0;

  while (true) {
    const client = await pool.connect();
    let batchLength = 0;
    try {
      await client.query(options.aplicar ? "BEGIN" : "BEGIN READ ONLY");
      const batch = await client.query<Row>(
        `SELECT id, ${target.column} AS encrypted, iv
         FROM ${target.table}
         WHERE id > $1
         ORDER BY id
         LIMIT $2
         ${options.aplicar ? "FOR UPDATE" : ""}`,
        [lastId, options.batchSize],
      );
      batchLength = batch.rows.length;

      for (const row of batch.rows) {
        lastId = row.id;
        totals.revisadas += 1;
        const result = classify(row, keys.oldKey, keys.newKey);

        if (result.kind === "nueva") {
          totals.yaConClaveNueva += 1;
          continue;
        }
        if (result.kind === "fallida") {
          totals.fallidas += 1;
          console.error(`FILA SIN DESCIFRAR ${target.table} id=${row.id}: no descifra con ninguna de las dos claves; se deja intacta.`);
          continue;
        }

        totals.pendientes += 1;
        if (!options.aplicar) continue;

        const replacement = encryptMessageWithKey(result.plaintext, keys.newKey);
        // Comprobación antes de escribir: lo nuevo descifra con la clave nueva
        // y devuelve exactamente el mismo texto.
        const check = decryptMessagePayloadWithKey(replacement.encrypted, replacement.iv, keys.newKey);
        if (check.plaintext !== result.plaintext) {
          throw new Error(`La comprobación del nuevo cifrado falló en ${target.table} id=${row.id}`);
        }

        const updated = await client.query(
          `UPDATE ${target.table}
           SET ${target.column} = $1, iv = $2
           WHERE id = $3 AND ${target.column} = $4 AND iv = $5`,
          [replacement.encrypted, replacement.iv, row.id, row.encrypted, row.iv],
        );
        if (updated.rowCount === 1) totals.recifradas += 1;
        else totals.cambiadasDuranteElProceso += 1;
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (batchLength === 0) break;
    console.log(`${target.table}: lote hasta id=${lastId} — ${JSON.stringify(totals)}`);
  }

  return totals;
}

async function main(): Promise<number> {
  const { aplicar } = parseArgs(process.argv.slice(2));
  const oldKey = readKey("OLD_MESSAGE_ENCRYPTION_KEY");
  const newKey = readKey("MESSAGE_ENCRYPTION_KEY");
  if (oldKey.equals(newKey)) {
    throw new ConfigError("OLD_MESSAGE_ENCRYPTION_KEY y MESSAGE_ENCRYPTION_KEY son iguales: la clave nueva debe ser distinta.");
  }
  const batchSize = readBatchSize();

  console.log(aplicar
    ? "Modo --aplicar: se vuelven a cifrar las filas con la clave nueva."
    : "Simulación: no se escribe nada. Usa --aplicar para escribir.");

  const porTabla: Record<string, Totals> = {};
  const total = emptyTotals();
  for (const target of TABLES) {
    const totals = await rotateTable(target, { oldKey, newKey }, { aplicar, batchSize });
    porTabla[target.table] = totals;
    for (const key of Object.keys(total) as (keyof Totals)[]) total[key] += totals[key];
  }

  console.log(`RESUMEN ${JSON.stringify({ modo: aplicar ? "aplicar" : "simulacion", total, porTabla })}`);
  if (total.fallidas > 0) {
    console.error(`${total.fallidas} filas no descifran con ninguna de las dos claves y se dejaron intactas. Revísalas antes de destruir la clave antigua.`);
    return 2;
  }
  if (!aplicar && total.pendientes > 0) {
    console.log(`${total.pendientes} filas se volverían a cifrar con --aplicar.`);
  }
  return 0;
}

main()
  .then(code => { process.exitCode = code; })
  .catch(err => {
    if (err instanceof ConfigError) {
      console.error(err.message);
    } else {
      // Solo el mensaje: nunca filas ni texto en claro.
      console.error(`Recifrado abortado; el lote en curso se deshizo y se puede repetir: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
