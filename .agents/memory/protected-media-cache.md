---
name: Protected media cache
description: Privacy-versus-performance decision for authenticated media delivery
---

Use browser-private, short-lived caching for reusable profile/server imagery and server-scoped clips/audio, but never store channel-message attachments, stories, or channel-library files. Revalidate stale resources only after checking current authorization. When adding a cache-specific Vary field, preserve any existing Vary: Origin from credentialed CORS.

**Why:** Applying no-store to every avatar and icon repeatedly transfers the same bytes and repeats database authorization on each page opening. A bounded revocation delay is acceptable for the less-sensitive imagery and server clips, but not for messages and private files.

**How to apply:** For new media categories, choose the tier explicitly according to sensitivity and frequency, check private cache and validator behavior with a browser, and test that revoked users cannot receive a conditional 304. Treat the freshness interval as the maximum revocation delay for already cached bytes.