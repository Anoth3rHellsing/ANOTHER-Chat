import { and, eq, notLike } from "drizzle-orm";
import {
  db,
  directMessagesTable,
  messagesTable,
  pool,
} from "@workspace/db";
import {
  decryptMessagePayload,
  encryptMessage,
  GCM_MESSAGE_PREFIX,
} from "./crypto";
import { logger } from "./logger";

type EncryptedRow = {
  id: number;
  contentEncrypted: string;
  iv: string;
};

type GroupEncryptedRow = {
  id: number;
  content: string;
  iv: string;
};

async function decryptAndMigrate(
  tableName: string,
  id: number,
  encrypted: string,
  iv: string,
  updateLegacy: (replacement: { encrypted: string; iv: string }) => Promise<void>,
): Promise<string> {
  let result: ReturnType<typeof decryptMessagePayload>;
  try {
    result = decryptMessagePayload(encrypted, iv);
  } catch (err) {
    logger.error({ err, tableName, messageId: id }, "Failed to decrypt encrypted message");
    throw err;
  }

  if (result.format === "legacy-cbc") {
    const replacement = encryptMessage(result.plaintext);
    try {
      await updateLegacy(replacement);
    } catch (err) {
      logger.error(
        { err, tableName, messageId: id },
        "Failed to lazily migrate legacy encrypted message",
      );
    }
  }

  return result.plaintext;
}

export async function decryptChannelMessage(row: EncryptedRow): Promise<string> {
  return decryptAndMigrate(
    "messages",
    row.id,
    row.contentEncrypted,
    row.iv,
    async replacement => {
      await db.update(messagesTable)
        .set({ contentEncrypted: replacement.encrypted, iv: replacement.iv })
        .where(and(
          eq(messagesTable.id, row.id),
          eq(messagesTable.contentEncrypted, row.contentEncrypted),
          eq(messagesTable.iv, row.iv),
          notLike(messagesTable.contentEncrypted, `${GCM_MESSAGE_PREFIX}%`),
        ));
    },
  );
}

export async function decryptDirectMessage(row: EncryptedRow): Promise<string> {
  return decryptAndMigrate(
    "direct_messages",
    row.id,
    row.contentEncrypted,
    row.iv,
    async replacement => {
      await db.update(directMessagesTable)
        .set({ contentEncrypted: replacement.encrypted, iv: replacement.iv })
        .where(and(
          eq(directMessagesTable.id, row.id),
          eq(directMessagesTable.contentEncrypted, row.contentEncrypted),
          eq(directMessagesTable.iv, row.iv),
          notLike(directMessagesTable.contentEncrypted, `${GCM_MESSAGE_PREFIX}%`),
        ));
    },
  );
}

export async function decryptGroupMessage(row: GroupEncryptedRow): Promise<string> {
  return decryptAndMigrate(
    "dm_group_messages",
    row.id,
    row.content,
    row.iv,
    async replacement => {
      await pool.query(
        `UPDATE dm_group_messages
         SET content=$1, iv=$2
         WHERE id=$3 AND content=$4 AND iv=$5 AND content NOT LIKE $6`,
        [
          replacement.encrypted,
          replacement.iv,
          row.id,
          row.content,
          row.iv,
          `${GCM_MESSAGE_PREFIX}%`,
        ],
      );
    },
  );
}