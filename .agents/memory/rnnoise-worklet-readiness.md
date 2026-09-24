---
name: RNNoise worklet readiness
description: A dependency behavior that affects startup and fallback for browser microphone filtering
---

The bundled RNNoise AudioWorklet loads its WASM asynchronously inside the processor constructor and has no `ready` message. Before that finishes, its `process` function returns successfully while producing silence. `onprocessorerror` therefore cannot be used as proof that startup completed.

**Why:** Inspection of the package worklet showed an asynchronous binary load followed by processor assignment, with no port notification. The currently observed browser startup succeeds, but a fixed startup wait cannot guarantee readiness on a slower device.

**How to apply:** Keep the raw microphone live while initializing, distinguish verified audio output from mere module load, and do not claim all slow-device initialization/fallback cases are proven by headless Chromium. Any future readiness probe should avoid treating intentionally suppressed ambient noise or a muted mic as a processor failure.