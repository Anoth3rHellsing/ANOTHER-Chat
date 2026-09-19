# Database baseline

`drizzle/0000_calm_vargas.sql` is the zero migration for the complete development schema as introspected on 2026-09-18.

## Objects added to the handwritten schema

### Columns on an existing table

- `users.custom_status`: `text`, nullable, no default.
- `users.status_emoji`: `varchar(20)`, nullable, no default.

### Complete tables

- `sessions`: `sid varchar NOT NULL`, `sess json NOT NULL`, `expire timestamp(6) NOT NULL`; PK `session_pkey`; index `IDX_session_expire`.
- `friend_requests`: `id serial NOT NULL`, `sender_id integer NOT NULL`, `receiver_id integer NOT NULL`, `status varchar(20) NOT NULL DEFAULT 'pending'`, `created_at timestamp DEFAULT now()`; PK, sender/receiver FKs with cascade delete, unique `(sender_id, receiver_id)`.
- `friendships`: `id serial NOT NULL`, `user1_id integer NOT NULL`, `user2_id integer NOT NULL`, `created_at timestamp DEFAULT now()`; PK, both user FKs with cascade delete, unique `(user1_id, user2_id)`.
- `stories`: `id serial NOT NULL`, `user_id integer NOT NULL`, `media_url text NOT NULL`, `media_type text NOT NULL DEFAULT 'image'`, `expires_at timestamptz NOT NULL DEFAULT now() + interval '24:00:00'`, `created_at timestamptz NOT NULL DEFAULT now()`; PK and user FK with cascade delete.
- `story_views`: `id serial NOT NULL`, `story_id integer NOT NULL`, `viewer_id integer NOT NULL`, `viewed_at timestamptz NOT NULL DEFAULT now()`; PK, story/viewer FKs with cascade delete, unique `(story_id, viewer_id)`.
- `clips`: `id serial NOT NULL`, `server_id integer NOT NULL`, `user_id integer NOT NULL`, `title text NOT NULL`, `video_url text NOT NULL`, `thumbnail_url text`, `created_at timestamptz NOT NULL DEFAULT now()`; PK and server/user FKs with cascade delete.
- `clip_likes`: `clip_id integer NOT NULL`, `user_id integer NOT NULL`; composite PK and both FKs with cascade delete.
- `clip_comments`: `id serial NOT NULL`, `clip_id integer NOT NULL`, `user_id integer NOT NULL`, `content text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`; PK and both FKs with cascade delete.
- `dm_groups`: `id serial NOT NULL`, `name varchar(100)`, `owner_id integer NOT NULL`, `created_at timestamp DEFAULT now()`; PK and owner FK with cascade delete.
- `dm_group_members`: `id serial NOT NULL`, `group_id integer NOT NULL`, `user_id integer NOT NULL`, `joined_at timestamp DEFAULT now()`; PK, group/user FKs with cascade delete, unique `(group_id, user_id)`.
- `dm_group_messages`: `id serial NOT NULL`, `group_id integer NOT NULL`, `user_id integer NOT NULL`, `content text NOT NULL`, `iv text NOT NULL`, `created_at timestamp DEFAULT now()`, `deleted_at timestamp`; PK and group/user FKs with cascade delete.
- `audit_log`: `id serial NOT NULL`, `server_id integer NOT NULL`, `actor_id integer`, `target_user_id integer`, `action varchar(60) NOT NULL`, `detail jsonb DEFAULT '{}'`, `created_at timestamp DEFAULT now()`; PK, server FK with cascade delete, user FKs with set-null delete, index `idx_audit_log_server (server_id, created_at DESC)`.
- `server_mutes`: `id serial NOT NULL`, `server_id integer NOT NULL`, `user_id integer NOT NULL`, `muted_by_id integer`, `expires_at timestamp NOT NULL`, `reason text`, `created_at timestamp DEFAULT now()`; PK, server/user FKs with cascade delete, moderator FK with set-null delete, unique `(server_id, user_id)`.
- `message_reports`: `id serial NOT NULL`, `message_id integer NOT NULL`, `reporter_id integer NOT NULL`, `server_id integer`, `reason text NOT NULL`, `status varchar(20) NOT NULL DEFAULT 'pending'`, `resolved_by_id integer`, `resolved_at timestamp`, `created_at timestamp DEFAULT now()`; PK, four FKs with the production-equivalent delete actions, unique `(message_id, reporter_id)`.
- `word_filters`: `id serial NOT NULL`, `server_id integer NOT NULL`, `word varchar(200) NOT NULL`, `created_by_id integer`, `created_at timestamp DEFAULT now()`; PK, server FK with cascade delete, creator FK with set-null delete, unique `(server_id, word)`.

### Objects missing from prior declarations of existing tables

- `messages`: FK `messages_reply_to_id_fkey`; index `idx_messages_channel (channel_id, created_at DESC)`.
- `direct_messages`: FKs for sender, recipient, and reply; indexes `dm_pair_idx`, `dm_recipient_idx`, and `dm_sender_idx`.
- `dm_read_cursors`: FKs for both user columns.
- `message_reactions`: message/user FKs; the real unique name is `message_reactions_message_id_user_id_emoji_key`.
- `message_attachments`: message/channel/uploader FKs; `claimed` is `boolean NOT NULL DEFAULT false`, not integer.
- `server_invites`: server/creator/used-by FKs; the real unique name is `server_invites_code_key`.

No enums, check constraints, policies, or views exist in the introspected public schema. The complete catalog contains 28 tables, 173 columns, 83 constraints (including 44 foreign keys), and 6 non-constraint indexes.

## Verification

The zero migration was applied to a fresh isolated PostgreSQL 16 cluster under `/tmp`. Canonical comparisons against the development database matched all 28 tables, 173 columns, 83 constraints, and 6 indexes. No migration, push, DDL, or DML command was run against the development database.

## Development history adoption

The development database predated the migration history table, so the baseline migration must never be replayed there. The first real versioned change, `0001_faithful_darwin`, was applied through Drizzle using an isolated migration folder containing only that migration. This created the history table with `0001` as its latest entry; subsequent runs with the complete migration folder skip the older baseline and report no pending migrations.