---
name: Private realtime recipients
description: Targeted event delivery and private group message routing on the shared realtime transport
---

Deliver one-user alerts and private-group messages through the transport's authenticated user-directed delivery. A topic whose name looks user-specific is not necessarily subscribed by the client; a group topic must not be assumed private just because its name contains a group ID.

**Why:** A mention event was emitted to a user-named topic the client never subscribed to, so default mention alerts never arrived. A plaintext private-group event sent to a group-named topic could be observed by unauthorized topic subscribers. Direct authenticated delivery makes both cases behave as intended without a new connection.

**How to apply:** When adding targeted realtime events, trace the server's recipient selection and the client's actual subscriptions end to end. For private content, prefer direct sends to authorized recipients rather than topic naming as an access boundary.