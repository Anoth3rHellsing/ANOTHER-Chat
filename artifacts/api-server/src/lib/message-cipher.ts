// Cifrado de mensajes con la clave como parámetro, sin leer el entorno.
// `crypto.ts` lo usa con MESSAGE_ENCRYPTION_KEY; la herramienta de rotación
// (`scripts/recifrar-mensajes.ts`) lo usa con la clave antigua y la nueva.
// Aquí no hay clave de respaldo ni valor por defecto (AGENTS.md §7.5).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const GCM_ALGORITHM = "aes-256-gcm";
const LEGACY_ALGORITHM = "aes-256-cbc";
const GCM_IV_BYTES = 12;

export const GCM_MESSAGE_PREFIX = "gcm:v1:";

export type MessageFormat = "gcm-v1" | "legacy-cbc";

/** true si `value` son exactamente 64 caracteres hexadecimales (32 bytes). */
export function isValidMessageKeyHex(value: string | undefined): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

function isEvenLengthHex(value: string): boolean {
  return value.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(value);
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("Message encryption key must be 32 bytes");
}

export function isGcmMessage(encrypted: string): boolean {
  return encrypted.startsWith(GCM_MESSAGE_PREFIX);
}

export function encryptMessageWithKey(
  plaintext: string,
  key: Buffer,
): { encrypted: string; iv: string } {
  assertKey(key);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(GCM_ALGORITHM, key, iv);
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

export function decryptMessagePayloadWithKey(
  encrypted: string,
  iv: string,
  key: Buffer,
): { plaintext: string; format: MessageFormat } {
  assertKey(key);
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

    const decipher = createDecipheriv(GCM_ALGORITHM, key, Buffer.from(iv, "hex"));
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

  const decipher = createDecipheriv(LEGACY_ALGORITHM, key, Buffer.from(iv, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "hex")),
    decipher.final(),
  ]).toString("utf8");
  return { plaintext, format: "legacy-cbc" };
}
