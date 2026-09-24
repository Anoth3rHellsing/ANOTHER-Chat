---
name: Watch opt-in membership
description: Participation and control decisions for synchronized viewing inside a voice call
---

Starting a watch session automatically makes its initiator a viewer, but other callers must explicitly join. Leaving the viewing session must not leave the call. When the controller leaves, control goes to the remaining viewer who joined first; if no viewers remain, the session ends.

**Why:** Starting a shared activity expresses the initiator's intent to watch, while being in the underlying call does not imply the same consent for anyone else. Control must stay with someone actually watching, and an empty session should not continue invisibly.

**How to apply:** Keep the call-membership and viewing-membership states separate in both voice channels and direct calls. Offer non-viewers an invitation without mounting a player, and ensure repeated joins use the authoritative current position.