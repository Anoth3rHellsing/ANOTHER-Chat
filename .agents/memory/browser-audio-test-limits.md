---
name: Browser audio test limits
description: Constraints and caveats of synthetic/headless Chromium audio verification
---

Chromium's fake microphone may accept both `applyConstraints` and a fresh `getUserMedia` request without enabling native noise suppression or automatic gain control. Echo cancellation can toggle successfully in the same environment. Treat `getSettings()` as the observed result, and report unsupported native options instead of asserting that a successful promise means processing changed.

**Why:** An isolated capture test requested each native option both ways; the fake device reported `false` again for noise suppression and gain, even after recapture. This is not evidence that physical devices behave the same way.

**How to apply:** Verify the actual capture settings when possible, preserve the prior live microphone if recapture fails, and leave real-device confirmation open. In headless WebRTC tests, a received audio track can show connected RTP and bytes yet report zero energy until a remote `<audio>` element is attached and played. Synthetic cross-correlation latency and Chromium process-tree CPU are approximate, not mobile battery or two-person listening tests.