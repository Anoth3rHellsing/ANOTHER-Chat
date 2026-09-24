---
name: WebRTC sender silence and source availability
description: Receiver track flags may not identify sender-side audio removal
---

Do not treat a receiver track's `readyState === 'live'` or `muted === false` as proof that the sender is currently sharing audio. In headless Chromium, `RTCRtpSender.replaceTrack(null)` stopped measured output while the corresponding receiver track remained live and unmuted.

**Why:** Source controls inferred audio availability from receiver track flags. After a screen share with audio stops and a new video-only share begins, this may show a screen-audio control that adjusts silence.

**How to apply:** For an exact availability indicator across stop/re-share and late join, send explicit scoped sender-side source state through existing call signaling. Receiver flags can still handle mute events, but they are insufficient as the sole source of truth. Do not mistake zero energy for absence: a valid shared source may be temporarily silent.