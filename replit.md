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
- `MESSAGE_ENCRYPTION_KEY` — 64-char hex string (32 bytes) for AES-256-CBC message encryption. Auto-generated on first build.

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
- `artifacts/api-server/src/lib/crypto.ts` — AES-256-CBC encrypt/decrypt for messages
- `artifacts/api-server/src/lib/websocket.ts` — WebSocket server (real-time messaging, typing indicators, status)
- `artifacts/api-server/src/lib/auth.ts` — requireAuth and requireAdmin middleware
- `artifacts/another-private/src/` — React frontend (login, register, main app layout, admin panel)

## Architecture decisions

- **Encrypt-then-store**: Messages are AES-256-CBC encrypted with a random IV per message before storing. IV stored alongside ciphertext in DB. Decrypted server-side before serving to authorized users.
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
