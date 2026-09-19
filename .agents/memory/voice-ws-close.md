---
name: Connection-bound voice membership
description: Why voice membership and cleanup must track concrete WebSocket connections rather than user-wide socket counts
---

**Rule:** Track voice membership by channel, user, and bound WebSocket connection ID. Unbind or close removes only that connection; publish member leave only when the user has no bound connections left in that channel.

**Why:** A user can have multiple simultaneous tabs or transports. User-wide cleanup either evicts an active voice tab when an unrelated socket closes or keeps a stale voice tab alive merely because another non-voice socket remains open.

**How to apply:** Require an authenticated HTTP join reservation before WebSocket bind. Treat bind/unbind and socket close as connection-scoped. HTTP leave may cancel an empty reservation but must not delete live sibling bindings.
