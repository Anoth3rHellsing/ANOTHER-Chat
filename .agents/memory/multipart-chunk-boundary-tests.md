---
name: Multipart chunk boundary tests
description: Why upload size boundaries must be exercised through real multipart HTTP requests
---

Test an upload chunk of exactly the advertised limit through the complete HTTP multipart parser, not only through database fixtures or lower-level storage tests. Also test one byte above the limit.

**Why:** A multipart parser may signal a size-limit error at equality. A synthetic session with the same byte count can pass all subsequent logic while actual browser chunks at the documented boundary are rejected. The failure is easy to miss when small-file integration tests pass.

**How to apply:** For future chunked upload changes, include a real HTTP multipart request at the exact chunk size and a negative over-limit request, then verify resume and final file bytes. Keep the parser's framing/limit behavior distinct from the application's own byte-count validation.