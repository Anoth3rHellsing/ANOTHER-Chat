---
name: Notification preference scope
description: Intentional device-local tradeoff for per-account notification preferences
---

Notification preferences are separated by authenticated account in each browser, but they are not synchronized between browsers or devices.

**Why:** This keeps the feature local to the existing client-side settings model and avoids modifying the database and its migration baseline for a preference that directly controls a browser permission and local sound. The tradeoff is that a user's choices on one device do not follow them to another.

**How to apply:** Describe this limitation plainly to users; if cross-device synchronization becomes a requirement, introduce an authenticated settings API and a versioned migration instead of silently assuming browser storage is global.