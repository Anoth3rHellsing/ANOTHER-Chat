---
name: Authenticated message encryption
description: Messages use versioned AES-256-GCM; legacy CBC rows migrate after successful reads or through a manual batch script
---

**Rule:** New channel, direct, and DM-group messages must use the versioned AES-256-GCM envelope. The encryption key is mandatory and must be exactly 64 hexadecimal characters; startup must fail closed when it is absent or malformed.

**Why:** CBC did not authenticate stored content, and the former deterministic fallback could silently encrypt under an unsafe key. Conditional lazy migration preserves readable legacy rows without allowing failed decryptions or concurrent reads to overwrite data.

**How to apply:** Keep the `gcm:v1:` envelope and 12-byte IV contract stable. Legacy CBC is decrypt-only with the configured key. Rewrite only after successful decryption and only while ID, ciphertext, IV, and legacy format still match. Never log keys, plaintext, or ciphertext.
