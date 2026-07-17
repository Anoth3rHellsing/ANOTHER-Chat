---
name: AES-256 message encryption
description: Messages are encrypted with AES-256-CBC before DB storage; IV stored per-row; key from MESSAGE_ENCRYPTION_KEY env var.
---

**Implementation:** `artifacts/api-server/src/lib/crypto.ts`
- Algorithm: AES-256-CBC
- Key: 32-byte hex string from `MESSAGE_ENCRYPTION_KEY` env var (64 hex chars)
- IV: 16 random bytes per message, stored as hex in `messages.iv` column
- Ciphertext stored in `messages.content_encrypted`
- Encrypt on sendMessage, decrypt on listMessages (per-message, server-side only)

**Key format:** 64-char hex string = 32 bytes. Generated once at project creation via `crypto.randomBytes(32).toString('hex')`.

**How to apply:** Never log or return the raw key. If rotating the key, existing messages cannot be decrypted with the new key — would need a migration script to re-encrypt.
