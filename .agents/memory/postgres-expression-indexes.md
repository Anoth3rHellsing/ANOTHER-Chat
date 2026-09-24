---
name: Postgres expression indexes
description: Drizzle migration pitfall for CASE-based PostgreSQL indexes
---

When defining a PostgreSQL btree index over a CASE expression in Drizzle, group the expression explicitly and verify the generated SQL against a disposable PostgreSQL database.

**Why:** The generator can otherwise emit `USING btree (CASE ... END)`, which PostgreSQL rejects; the index expression needs the extra grouping of `((CASE ... END))`.

**How to apply:** Check generated SQL rather than assuming a successful code generation means a valid migration. Run the full versioned migration chain on a temporary cluster; do not use the owner's development database to test it.