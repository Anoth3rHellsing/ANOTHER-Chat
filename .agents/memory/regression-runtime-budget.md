---
name: Regression runtime budget
description: Lessons from running several independently migrated PostgreSQL test clusters within a short time budget
---

Keep short regression commands free of fixed quota-window waits, and measure the **whole concurrent run** in more than one order rather than summing individual scenario times. A fast scenario alone may take much longer alongside multiple migration/build processes.

**Why:** Parallel PostgreSQL startup and API bundling contend for CPU and disk. A broad scanner scenario made one run approach the two-minute limit; a reversed run under additional typechecking exceeded a shell timeout even though each scenario was independently reliable. A shell-level timeout can terminate a test before its `finally` cleanup runs, leaving disposable directories to inspect and remove.

**How to apply:** Keep a small local-provider smoke scenario in the default suite and run exhaustive quota-window checks separately. Avoid unrelated builds while measuring. If a command is externally timed out, check for live test database processes before removing its known disposable `/tmp` directories.

For shared Replit runs, serialize the migration-plus-API lifecycle scenarios by default.

**Why:** Running the authentication and realtime/category scenarios concurrently caused an intermittent loopback socket reset; both passed alone, and the serialized full suite passed.

**How to apply:** Keep the default suite at concurrency 1 unless measured runs establish that higher concurrency is reliable and remains within the timeout budget.