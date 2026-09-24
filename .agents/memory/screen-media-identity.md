---
name: Shared-screen media identity
description: Why microphone and screen audio need separate stream identities and order-independent remote classification
---

Keep microphone audio associated with the camera's logical stream and screen audio associated with screen video on a distinct stream. Do not infer that a video-only stream is a screen until the microphone stream's identity is established; track arrival order is not guaranteed. The receiver must keep microphone and screen audio independently identifiable.

**Why:** An earlier mixer associated outgoing audio with a new destination stream and left the camera stream video-only for late peers, which promoted the camera into the screen region. After separating microphone and screen audio, a screen-audio-first arrival could still misclassify pending camera video if unknown streams were treated as screens.

**How to apply:** When changing senders or remote track classification, test mic-first, screen-audio-first, and camera-first delivery, plus peers joining during capture setup. Treat new tracks added to an existing MediaStream as observable state changes even when the stream object is unchanged.