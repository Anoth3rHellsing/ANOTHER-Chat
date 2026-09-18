---
name: Complete database baseline
description: Raw-SQL feature tables are declared in Drizzle and covered by a verified zero migration
---

**Rule:** Keep exactly one Drizzle `pgTable` declaration per physical table, organized by functional domain. Public raw-name and `*Table` exports must alias that same object. Keep the zero migration complete even when routes use raw SQL.

**Why:** The development database accumulated feature tables and constraints outside the handwritten schema, making clean reconstruction impossible. The full catalog is now represented and verified against a temporary empty database.

**How to apply:** Add new objects to their domain schema module and generated migrations even if a route uses `pool.connect()`. Preserve names, types, nullability, defaults, indexes, and constraints unless a separate migration intentionally changes them. Regenerating after a file-only reorganization must report no schema changes.
