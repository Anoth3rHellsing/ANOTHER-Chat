import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { logger } from "./logger";

const ALGORITHM = "aes-256-cbc";
const IV_LENGTH = 16;

function getKey(): Buffer {
  const key = process.env.MESSAGE_ENCRYPTION_KEY;
  if (!key) {
    logger.warn("MESSAGE_ENCRYPTION_KEY not set — using insecure fallback. Set this secret in production.");
    // Deterministic fallback for development only — 32 bytes hex
    return Buffer.from("a".repeat(64), "hex");
  }
  // Accept hex string (64 chars = 32 bytes) or raw 32-char string
  if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
    return Buffer.from(key, "hex");
  }
  // Pad/truncate to 32 bytes
  const buf = Buffer.alloc(32);
  Buffer.from(key).copy(buf);
  return buf;
}

export function encryptMessage(plaintext: string): { encrypted: string; iv: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  return {
    encrypted,
    iv: iv.toString("hex"),
  };
}

export function decryptMessage(encrypted: string, iv: string): string {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
