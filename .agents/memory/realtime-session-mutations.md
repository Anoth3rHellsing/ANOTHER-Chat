---
name: Realtime session mutations
description: Preventing races when multiple WebSocket clients mutate ephemeral shared sessions
---

For an in-memory session shared by several WebSocket connections, finish asynchronous lookups first, then recheck exact connection membership and the latest session state immediately before a synchronous read-modify-save. Do not keep an earlier copied session across an `await`.

**Why:** Individual sockets serialize their own messages, but messages from different clients overlap. A profile lookup between reading and saving can overwrite a peer's queue change; a participant departing during a lookup can let a later start resurrect an orphan session.

**How to apply:** Use this ordering for shared call features that fetch actor metadata or other data before establishing or mutating an ephemeral session. Confirm the client is still open and bound before committing.