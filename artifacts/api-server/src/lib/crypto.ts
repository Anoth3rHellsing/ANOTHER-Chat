import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_ENV_NAME = "MESSAGE_ENCRYPTION_KEY";
const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const GCM_ALGORITHM = "aes-256-gcm";
const LEGACY_ALGORITHM = "aes-256-cbc";
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export const GCM_MESSAGE_PREFIX = "gcm:v1:";

function loadMessageEncryptionKey(): Buffer {
  const value = process.env[KEY_ENV_NAME];
  if (!value) {
    throw new Error(
      `${KEY_ENV_NAME} is required. Set it to exactly 64 hexadecimal characters (32 bytes) before starting the server.`,
    );
  }
  if (!KEY_PATTERN.test(value)) {
    throw new Error(
      `${KEY_ENV_NAME} must contain exactly 64 hexadecimal characters (32 bytes).`,
    );
  }
  return Buffer.from(value, "hex");
}

const MESSAGE_ENCRYPTION_KEY = loadMessageEncryptionKey();

function isEvenLengthHex(value: string): boolean {
  return value.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(value);
}

export function isGcmMessage(encrypted: string): boolean {
  return encrypted.startsWith(GCM_MESSAGE_PREFIX);
}

export function encryptMessage(plaintext: string): { encrypted: string; iv: string } {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(GCM_ALGORITHM, MESSAGE_ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: `${GCM_MESSAGE_PREFIX}${ciphertext.toString("hex")}:${authTag.toString("hex")}`,
    iv: iv.toString("hex"),
  };
}

export function decryptMessagePayload(
  encrypted: string,
  iv: string,
): { plaintext: string; format: "gcm-v1" | "legacy-cbc" } {
  if (isGcmMessage(encrypted)) {
    const parts = encrypted.split(":");
    if (
      parts.length !== 4 ||
      parts[0] !== "gcm" ||
      parts[1] !== "v1" ||
      !isEvenLengthHex(parts[2]) ||
      !/^[0-9a-fA-F]{32}$/.test(parts[3]) ||
      !/^[0-9a-fA-F]{24}$/.test(iv)
    ) {
      throw new Error("Invalid gcm:v1 encrypted message envelope");
    }

    const decipher = createDecipheriv(
      GCM_ALGORITHM,
      MESSAGE_ENCRYPTION_KEY,
      Buffer.from(iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(parts[3], "hex"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parts[2], "hex")),
      decipher.final(),
    ]).toString("utf8");
    return { plaintext, format: "gcm-v1" };
  }

  if (!isEvenLengthHex(encrypted) || !/^[0-9a-fA-F]{32}$/.test(iv)) {
    throw new Error("Invalid legacy AES-256-CBC message payload");
  }

  const decipher = createDecipheriv(
    LEGACY_ALGORITHM,
    MESSAGE_ENCRYPTION_KEY,
    Buffer.from(iv, "hex"),
  );
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "hex")),
    decipher.final(),
  ]).toString("utf8");
  return { plaintext, format: "legacy-cbc" };
}

export function decryptMessage(encrypted: string, iv: string): string {
  return decryptMessagePayload(encrypted, iv).plaintext;
}