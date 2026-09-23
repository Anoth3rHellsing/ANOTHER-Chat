---
name: Voice bind readiness
description: Why voice negotiation must wait for confirmed WebSocket binding
---

Voice membership from the HTTP join response is not proof that a member's WebSocket connection can receive a voice offer. Offer only to confirmed bound peers; use the bind acknowledgement for existing peers and member-join notifications for peers binding afterward.

**Why:** The server intentionally routes voice signals only between bound connections. Simultaneous HTTP joins can list both members while either socket is still unbound, silently losing early offers.

**How to apply:** Keep this distinction in voice reconnect and multi-tab changes. Do not use an HTTP member list alone to decide signaling readiness.