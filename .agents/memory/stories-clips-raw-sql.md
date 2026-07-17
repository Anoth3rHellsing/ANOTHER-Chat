---
name: Stories and clips routes use raw SQL
description: stories/clips/story_views/clip_likes/clip_comments tables are not in the Drizzle schema; routes use raw pg pool queries
---

**Rule:** Never try to use drizzle ORM for the stories, story_views, clips, clip_likes, or clip_comments tables. Use raw `pool.connect()` queries.

**Why:** These tables were added via raw `psql` migration after the Drizzle schema was already generated. Adding them to the schema would require regenerating all codegen. Raw SQL was chosen to avoid that churn.

**How to apply:** Import `pool` from `@workspace/db` (it is exported from `lib/db/src/index.ts`). Use `const client = await pool.connect(); try { return await client.query(text, values); } finally { client.release(); }` pattern. Both `artifacts/api-server/src/routes/stories.ts` and `clips.ts` use a local `rawQuery()` helper with dynamic import to avoid circular init issues.
