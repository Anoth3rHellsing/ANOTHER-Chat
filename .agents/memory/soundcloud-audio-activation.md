---
name: SoundCloud audio activation
description: Browser autoplay can produce SoundCloud widget activity without audible output
---

Treat SoundCloud's reported volume and play progress as widget state, not proof of audible browser output. Its official widget API uses integer volume 0–100, matching YouTube's API; a nominal volume-scale mismatch is not the explanation for silent starts.

**Why:** In an isolated Chromium check, the real component and official widget reported volume 60 and briefly advanced while the audio monitor stayed at zero and playback was then paused. A real click on the local activation action produced nonzero audio without changing the requested 60; silencing with volume 0 returned the output to zero. The widget has no getter for the browser's actual audio output.

**How to apply:** For synchronized embedded playback, distinguish player-reported volume from audible output, keep a clear per-device gesture to activate audio, and avoid claiming that `getVolume()` proves a user hears the track. Use a real browser/audio-output check to assess autoplay changes.