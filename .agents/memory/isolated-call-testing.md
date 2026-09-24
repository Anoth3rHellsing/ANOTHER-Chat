---
name: Isolated call testing
description: Browser-session isolation for two-user voice and DM tests
---

Use a separate Chromium browser context (not merely a separate tab or target) for each test account when exercising two-person calls through CDP.

**Why:** CDP's cookie operations in ordinary targets share the default browser context. A second user's login silently replaces the first user's cookies, making two tabs appear to be two peers when both are actually the same account. This caused misleading call-test failures.

**How to apply:** Create each target inside its own browser context, then set cookies in that target and confirm the two rendered account identities differ before testing signaling or media.