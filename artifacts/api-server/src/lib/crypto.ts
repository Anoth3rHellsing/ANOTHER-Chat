import {
  decryptMessagePayloadWithKey,
  encryptMessageWithKey,
  isValidMessageKeyHex,
  type MessageFormat,
} from "./message-cipher";

export { GCM_MESSAGE_PREFIX, isGcmMessage } from "./message-cipher";

const KEY_ENV_NAME = "MESSAGE_ENCRYPTION_KEY";

function loadMessageEncryptionKey(): Buffer {
  const value = process.env[KEY_ENV_NAME];
  if (!value) {
    throw new Error(
      `${KEY_ENV_NAME} is required. Set it to exactly 64 hexadecimal characters (32 bytes) before starting the server.`,
    );
  }
  if (!isValidMessageKeyHex(value)) {
    throw new Error(
      `${KEY_ENV_NAME} must contain exactly 64 hexadecimal characters (32 bytes).`,
    );
  }
  return Buffer.from(value, "hex");
}

const MESSAGE_ENCRYPTION_KEY = loadMessageEncryptionKey();

export function encryptMessage(plaintext: string): { encrypted: string; iv: string } {
  return encryptMessageWithKey(plaintext, MESSAGE_ENCRYPTION_KEY);
}

export function decryptMessagePayload(
  encrypted: string,
  iv: string,
): { plaintext: string; format: MessageFormat } {
  return decryptMessagePayloadWithKey(encrypted, iv, MESSAGE_ENCRYPTION_KEY);
}

export function decryptMessage(encrypted: string, iv: string): string {
  return decryptMessagePayload(encrypted, iv).plaintext;
}
