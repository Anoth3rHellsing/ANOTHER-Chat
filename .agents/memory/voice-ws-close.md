---
name: Connection-bound voice membership
description: Why voice membership and cleanup must track concrete WebSocket connections rather than user-wide socket counts
---

**Rule:** Track voice membership by channel, user, and bound WebSocket connection ID. Unbind or close removes only that connection; publish member leave only when the user has no bound connections left in that channel.

**Why:** A user can have multiple simultaneous tabs or transports. User-wide cleanup either evicts an active voice tab when an unrelated socket closes or keeps a stale voice tab alive merely because another non-voice socket remains open.

**How to apply:** Require an authenticated HTTP join reservation before WebSocket bind. Treat bind/unbind and socket close as connection-scoped. HTTP leave may cancel an empty reservation but must not delete live sibling bindings.

**Reconnect rule:** Restore the HTTP join reservation before binding a replacement WebSocket, and confirm the bind acknowledgement; replaying channel subscriptions or sending a bare bind is insufficient. A low-frequency bind on the existing connection can detect lost membership without creating a new reservation on every check.

**Why:** Closing the last bound connection deletes the membership, and a fresh server process has no voice map at all. The new connection must pass the same authorized join path; otherwise it can remain locally in a call while absent from server-side presence.

**How to apply:** On transport recovery, treat audio peer sessions as potentially stale and allow fresh negotiation after the bound acknowledgement. If authorization or repeated binding fails, explicitly end the local call instead of displaying a joined state indefinitely.
