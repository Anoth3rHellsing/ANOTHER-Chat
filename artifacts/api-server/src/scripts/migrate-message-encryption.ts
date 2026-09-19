import { pool } from "@workspace/db";
import {
  decryptMessagePayload,
  encryptMessage,
  GCM_MESSAGE_PREFIX,
} from "../lib/crypto";
import { logger } from "../lib/logger";

const parsedBatchSize = Number(process.env.MESSAGE_MIGRATION_BATCH_SIZE ?? 100);
const BATCH_SIZE = Number.isInteger(parsedBatchSize) && parsedBatchSize > 0
  ? Math.min(parsedBatchSize, 1_000)
  : 100;

const TABLES = [
  { table: "messages", encryptedColumn: "content_encrypted" },
  { table: "direct_messages", encryptedColumn: "content_encrypted" },
  { table: "dm_group_messages", encryptedColumn: "content" },
] as const;

type MigrationTotals = {
  scanned: number;
  converted: number;
  failed: number;
  skipped: number;
};

async function migrateTable(
  table: typeof TABLES[number],
): Promise<MigrationTotals> {
  const totals: MigrationTotals = { scanned: 0, converted: 0, failed: 0, skipped: 0 };
  let lastId = 0;

  while (true) {
    const batch = await pool.query<{
      id: number;
      encrypted: string;
      iv: string;
    }>(
      `SELECT id, ${table.encryptedColumn} AS encrypted, iv
       FROM ${table.table}
       WHERE id > $1 AND ${table.encryptedColumn} NOT LIKE $2
       ORDER BY id
       LIMIT $3`,
      [lastId, `${GCM_MESSAGE_PREFIX}%`, BATCH_SIZE],
    );

    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      lastId = row.id;
      totals.scanned += 1;

      try {
        const result = decryptMessagePayload(row.encrypted, row.iv);
        if (result.format !== "legacy-cbc") {
          totals.skipped += 1;
          continue;
        }

        const replacement = encryptMessage(result.plaintext);
        const updated = await pool.query(
          `UPDATE ${table.table}
           SET ${table.encryptedColumn}=$1, iv=$2
           WHERE id=$3
             AND ${table.encryptedColumn}=$4
             AND iv=$5
             AND ${table.encryptedColumn} NOT LIKE $6`,
          [
            replacement.encrypted,
            replacement.iv,
            row.id,
            row.encrypted,
            row.iv,
            `${GCM_MESSAGE_PREFIX}%`,
          ],
        );

        if (updated.rowCount === 1) totals.converted += 1;
        else totals.skipped += 1;
      } catch (err) {
        totals.failed += 1;
        logger.error(
          { err, tableName: table.table, messageId: row.id },
          "Message encryption migration row failed; row was not modified",
        );
      }
    }

    logger.info(
      { tableName: table.table, batchLastId: lastId, ...totals },
      "Message encryption migration batch completed",
    );
  }

  return totals;
}

async function main(): Promise<void> {
  const grandTotals: MigrationTotals = { scanned: 0, converted: 0, failed: 0, skipped: 0 };

  for (const table of TABLES) {
    const totals = await migrateTable(table);
    grandTotals.scanned += totals.scanned;
    grandTotals.converted += totals.converted;
    grandTotals.failed += totals.failed;
    grandTotals.skipped += totals.skipped;
    logger.info({ tableName: table.table, ...totals }, "Message encryption table migration completed");
  }

  logger.info(grandTotals, "Message encryption migration completed");
  if (grandTotals.failed > 0) process.exitCode = 1;
}

main()
  .catch(err => {
    logger.fatal({ err }, "Message encryption migration aborted");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });