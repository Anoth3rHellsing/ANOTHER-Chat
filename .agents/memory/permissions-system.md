---
name: Permissions System
description: How the role/permission system is structured and where the key files live.
---

# A.N.O.T.H.E.R. Permissions System

## Schema
- `server_roles` table: id, server_id, name, color, permissions (integer bitmask), position
- `server_member_roles` table: id, member_id (FK→server_members.id), role_id (FK→server_roles.id)
- `channels.restricted_roles` column: TEXT storing JSON array of role IDs (empty = unrestricted)

## Permission bitmask
- `1` = manage_channels
- `2` = kick_members
- `4` = ban_members
- `8` = manage_messages

## Key backend files
- `artifacts/api-server/src/lib/permissions.ts` — `getMemberPermissions()`, `hasPerm()`, `PERM` constants
- `artifacts/api-server/src/routes/roles.ts` — CRUD for roles + member role assignment
- `artifacts/api-server/src/routes/channels.ts` — role-based channel filtering on listChannels
- `artifacts/api-server/src/routes/servers.ts` — getMemberCustomRoles() included in member responses

## Key frontend files
- `artifacts/another-private/src/lib/permissions.ts` — PERM constants, hasPerm(), getEffectivePermissions()
- `artifacts/another-private/src/components/server-settings-modal.tsx` — Roles tab (CRUD), Channels tab (restrictions), Members tab (assignment)
- `artifacts/another-private/src/pages/app-layout.tsx` — uses getEffectivePermissions() to gate create-channel button

## Why separate lib/permissions.ts on frontend
Vite Fast Refresh requires all exports from a .tsx component file to be React components. Non-component constants (PERM, hasPerm, etc.) must live in a plain .ts file to avoid the "export is incompatible" HMR warning.

## Shortcut: owner/admin always get 0xffffffff
getMemberPermissions() returns ALL_PERMS (0xffffffff) for owner and admin roles without checking the junction table.
