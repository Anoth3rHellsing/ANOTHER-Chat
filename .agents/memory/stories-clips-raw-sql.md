---
name: Complete database baseline
description: Raw-SQL feature tables are declared in Drizzle and covered by a verified zero migration
---

**Rule:** Keep the Drizzle schema and zero migration complete even when application routes continue to use raw SQL.

**Why:** The development database accumulated feature tables and constraints outside the handwritten schema, making clean reconstruction impossible. The full catalog is now represented and verified against a temporary empty database.

**How to apply:** New database objects must be added to the Drizzle schema and generated migrations even if a route uses `pool.connect()`. Preserve the live catalog's names, types, nullability, defaults, indexes, and constraints unless a separate hardening migration intentionally changes them.
