---
name: Private UI visual checks
description: Scope and limitations of styling previews when no authenticated session is available
---

For visual-only work in the private chat app, an isolated browser with read-only response fixtures can render authenticated surfaces without creating or deleting database records.

**Why:** The normal preview starts at login. Visual review still needs message lists, sidebars, modals and chat states; creating test accounts may conflict with a request not to alter data. Browser-only fixtures let those surfaces be inspected while preserving the database.

**How to apply:** Clearly label fixture-backed screenshots as visual checks, not evidence that message sending, voice joining, or other server behavior works. Test functional flows only with a legitimate authenticated test session when one is available and the user permits the needed data changes.