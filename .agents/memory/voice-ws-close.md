---
name: Voice WS close handler
description: Why voice auto-leave must check for other open WS connections before evicting a user from voice
---

**Rule:** In `artifacts/api-server/src/lib/websocket.ts` close handler, before calling `leaveVoiceChannel`, check `wss.clients` for any other open socket with the same `userId`. Only auto-leave if none exist.

**Why:** Multiple WS connections are open per user simultaneously — `use-webrtc.ts` opens one persistent connection and `use-chat-websocket.ts` opens another that reconnects whenever `channelId` changes. When the chat hook reconnects (e.g. user switches channels), the old socket closes, triggering the close handler. Without the check, this closes the voice session for the user even while they're still in a voice channel via the other socket.

**How to apply:** Pattern: `Array.from(wss!.clients).some(c => c !== client && c.readyState === WebSocket.OPEN && c.userId === client.userId)`. Only proceed with eviction if `hasOtherConnections` is false.
