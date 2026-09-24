# A.N.O.T.H.E.R. Private

A private, invite-only Discord-style encrypted chat web application. Dark theme, Spanish UI, real-time messaging with WebSockets, AES-256 message encryption, and an admin management panel.

## Run & Operate

- `pnpm --filter @workspace/another-private run dev` — run the frontend (port 19327, served at `/`)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, served at `/api` and `/ws`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

## Required Environment Secrets

- `DATABASE_URL` — Postgres connection string (managed by Replit)
- `SESSION_SECRET` — Express session secret
- `MESSAGE_ENCRYPTION_KEY` — required 64-character hexadecimal string (32 bytes) for AES-256-GCM message encryption. The API aborts startup if it is missing or malformed.
- `FILE_CHANNEL_MAX_MB` — optional positive integer limit for private media-channel files; defaults to `100` MiB.
- `VirusTotal_Key` or `VIRUSTOTAL_API_KEY` — optional VirusTotal API key, available from the API key section of a VirusTotal account. Either secret name is supported. Without either, private file upload/download remains available and scanning reports unavailable; startup does not fail. A file or its hash is sent to VirusTotal only after an authenticated user explicitly invokes verification with `{ "consent": true }`.

### VirusTotal privacy and terms

VirusTotal scanning is opt-in per file. On consent, the service first checks the SHA-256 hash and only uploads file bytes if no report exists. File scans are asynchronous; incomplete results are never presented as clean. Scanning is limited to 650 MiB per file; listing metadata includes each file's server-detected scan eligibility and extension-mismatch state. Oversized files return 413 and out-of-scope files return 422 before hash-cache or VirusTotal requests. Pending scans resume polling when either supported key name is configured. VirusTotal's public API is limited to 4 requests per minute and 500 per day and **must not be used in commercial products or services**. VirusTotal terms also restrict using the public API for business workflows that do not contribute new files. Review current VirusTotal terms and API documentation and use an appropriate licensed plan for any commercial/business use. Do not configure a public API key for prohibited use.

Private channel library file bytes are stored in `private-channel-files/`, outside public `/api/uploads`; downloads always pass channel authorization and are forced attachments with `nosniff` and a restrictive CSP. `FILE_CHANNEL_MAX_MB` limits total file size; resumable chunks are 4 MiB and unfinished sessions expire after 24 hours.

## Voice connectivity (frontend build environment)

- `VITE_ICE_SERVERS` — optional JSON array replacing the entire ICE server list, e.g. `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:example.net:3478","username":"name","credential":"password"}]`. Without it, three public STUN servers are used; no TURN relay is configured. Browser Vite variables are public in the built client: do not put private TURN credentials in this variable. Use ephemeral client credentials if a relay is added later.
- `VITE_VOICE_DEBUG=true` enables per-peer negotiation/ICE logs at build time. For a single browser without rebuilding, run `localStorage.setItem('voiceDebug','true')` then reload; disable with `localStorage.removeItem('voiceDebug')` and reload. Logs include candidate counts/types and selected route types/protocol, never addresses.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite + Wouter + Tailwind + Framer Motion
- API: Express 5 with express-session (PostgreSQL session store via connect-pg-simple)
- DB: PostgreSQL + Drizzle ORM
- Auth: bcrypt password hashing, cookie-based sessions
- Real-time: WebSocket (ws) at `/ws`
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts
- `lib/api-spec/fix-zod-barrel.mjs` — post-codegen script that fixes the api-zod barrel to avoid TS2308 collisions
- `lib/db/src/schema/` — Drizzle table definitions (users, servers, channels, messages, inviteCodes)
- `artifacts/api-server/src/routes/` — Express route handlers (auth, servers, channels, users, admin)
- `artifacts/api-server/src/lib/crypto.ts` — versioned AES-256-GCM encryption and legacy AES-256-CBC decryption for messages
- `pnpm --filter @workspace/api-server run migrate-message-encryption` — manually convert legacy channel, direct, and DM-group messages to GCM in batches; safe to rerun
- `artifacts/api-server/src/lib/websocket.ts` — WebSocket server (real-time messaging, typing indicators, status)
- `artifacts/api-server/src/lib/auth.ts` — requireAuth and requireAdmin middleware
- `artifacts/another-private/src/` — React frontend (login, register, main app layout, admin panel)

## Architecture decisions

- **Authenticated encrypt-then-store**: New messages use AES-256-GCM with a random 12-byte IV. `content_encrypted`/`content` stores `gcm:v1:<ciphertext-hex>:<16-byte-auth-tag-hex>` and the IV column stores the 12-byte IV as hex. Legacy CBC rows are migrated after successful reads or by the manual batch script.
- **Session-based auth**: express-session with PostgreSQL store. Session cookie (httpOnly, 30-day maxAge). No JWTs.
- **First-user admin**: The very first registered user gets the `admin` role and doesn't need an invite code. Subsequent users require a valid single-use invite code.
- **WebSocket path in artifact.toml**: `/ws` is listed in the api-server's `paths` array so the proxy routes WebSocket connections to it.
- **Codegen barrel fix**: Orval's split mode generates a barrel `lib/api-zod/src/index.ts` re-exporting from both `generated/api` (Zod schemas) and `generated/types` (TS types), causing TS2308 collisions. A post-codegen fix script (`fix-zod-barrel.mjs`) overwrites this with only `generated/api` exports.

## Product

- Invite-only private chat replacing Discord for a small trusted group
- Full Discord-like layout: server list sidebar, channel list, chat area, member panel
- Real-time messaging, typing indicators, online status
- Encrypted message storage (AES-256)
- Admin panel: invite code management, user management (kick/ban), activity stats
- Profile editing with avatar/GIF upload and banner support
- All UI in Spanish, always dark mode

## User preferences

- Interface language: Spanish
- Always dark mode (no toggle)
- App name: "A.N.O.T.H.E.R. Private"

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after changing `lib/api-spec/openapi.yaml`. The codegen script automatically fixes the api-zod barrel.
- For file uploads (avatar, banner), use raw `fetch` with `FormData` — the multipart endpoints are not in the OpenAPI spec and have no generated hooks.
- The WebSocket path `/ws` must remain in `artifacts/api-server/.replit-artifact/artifact.toml`'s `paths` array. Without it, the proxy drops WebSocket connections silently.
- bcrypt requires native build — it's listed in `onlyBuiltDependencies` in `pnpm-workspace.yaml`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
