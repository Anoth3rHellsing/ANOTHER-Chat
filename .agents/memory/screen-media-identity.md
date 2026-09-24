---
name: Shared-screen media identity
description: Why outgoing mixed audio must retain its original stream identity in voice calls
---

When sending a Web Audio mix instead of the microphone track, associate the replacement audio sender with the same logical stream used for the microphone and camera. Send screen video on a distinct stream. A video-only remote stream is not, by itself, proof that it represents a screen: a camera can arrive before audio, and a mixer associated with a different stream can make an ordinary camera appear video-only.

**Why:** A first screen-sharing implementation associated the mixed audio with the mixer destination stream, making the original camera stream video-only for new peers. The receiver then promoted the camera into the shared-screen region. Browser track arrival order also varies during renegotiation.

**How to apply:** Whenever changing audio senders or remote track classification, preserve the camera/microphone stream association and test both audio-first and camera-first track delivery. Treat new tracks added to an existing MediaStream as observable state changes even when the stream object itself is unchanged.