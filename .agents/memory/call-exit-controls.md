---
name: Call exit controls
description: Critical call actions must remain visible in narrow and feature-heavy layouts
---

Keep hang-up and expand/minimize actions in a fixed, non-wrapping group at a predictable edge of both compact and expanded call controls. Let secondary actions wrap or move behind a disclosure; never put the call exit in that secondary group.

**Why:** The owner confirmed that a growing single-row toolbar overflowed the narrow sidebar. In watchparty calls, expand and hang-up were rendered but clipped, leaving a caller unable to exit or restore the view. This is a functional safety issue, not cosmetic polish.

**How to apply:** Every new in-call action must be tested at the sidebar's narrowest width and on small viewports alongside watchparty, sharing, soundboard and source controls. Check real element bounds and clicks, not only that the buttons appear in the DOM.