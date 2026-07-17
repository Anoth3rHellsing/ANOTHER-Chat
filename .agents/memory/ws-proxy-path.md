---
name: WebSocket proxy path
description: The /ws path must be listed in the api-server's artifact.toml paths array or the Replit proxy silently drops WebSocket connections.
---

**The rule:** Any path the app uses (REST or WebSocket) must appear in `artifacts/<slug>/.replit-artifact/artifact.toml` under `[[services]] paths`.

**Current state:** `artifacts/api-server/.replit-artifact/artifact.toml` has `paths = ["/api", "/ws"]`.

**Why:** The shared Replit proxy only forwards explicitly listed paths. An unlisted WS path is silently dropped — the server never sees the connection, and the client gets no error (just a failed handshake).

**How to apply:** When adding a new WebSocket endpoint or moving WS to a different path, update artifact.toml via `verifyAndReplaceArtifactToml` (never edit artifact.toml directly).
