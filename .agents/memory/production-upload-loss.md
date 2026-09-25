---
name: Production upload loss
description: How to interpret broken uploaded media when database references outlive local production files
---

Do not treat an uploaded-media 404 as a browser-cookie problem by default. Production has returned repeated 404s for paths that still have exactly one database reference; authenticated app requests alongside them succeed. The local upload filesystem can lose bytes while database references remain.

**Why:** The authorization middleware distinguishes missing sessions (401) from missing or unavailable media (404). A surviving reference cannot recreate the original image bytes, and relaxing media authorization would not restore them.

**How to apply:** Check reference matches and request status without exposing owner data. If the bytes are absent, restore from an original upload or backup; use persistent private storage for future media while preserving existing access checks.