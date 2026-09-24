---
name: Temporary PostgreSQL clusters
description: A Replit-specific issue when booting disposable local PostgreSQL clusters for isolated integration tests.
---

Disposable PostgreSQL 16 clusters launched inside this workspace may fail to start when they use PostgreSQL's default Unix-socket directory. Supply a writable socket directory inside the temporary fixture even if every test client connects over `127.0.0.1`.

**Why:** A temporary cluster started correctly only after explicitly setting its socket directory to a writable fixture path; binding its TCP listener alone did not avoid the socket startup failure.

**How to apply:** For future isolated integration tests, keep both the data directory and socket directory disposable and verify that teardown stops the cluster before removing its files. Never point a test at the development or production database.