---
name: Soundboard local playback
description: Product decision for soundboard delivery, per-listener control, and shared-server scope
---

Soundboard clips must not be mixed into the sender's outgoing WebRTC audio track, not even as an optional mode. Send a small trigger to the other authenticated, active call participants through the existing realtime transport; each client retrieves and plays the clip locally. The sender plays locally after the server accepts the trigger. For a direct call, use only a library from a server shared by both participants.

**Why:** If mixed into voice, a receiver cannot mute the soundboard without also silencing the speaker. Local playback gives each participant independent soundboard mute and volume, avoids renegotiating WebRTC, and keeps clip bytes off the realtime channel. Server-scoped libraries need shared membership in direct calls.

**How to apply:** Keep voice media and soundboard audio gains independent. Validate active call membership and rate limits server-side; route triggers to bound call connections rather than a public topic or all user tabs. Do not replace this with audio-track mixing while adding further soundboard features.