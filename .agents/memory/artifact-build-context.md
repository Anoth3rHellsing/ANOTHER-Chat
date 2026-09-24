---
name: Artifact build context
description: Why standalone builds and preview URLs differ from managed artifact workflows
---

Ad hoc shell builds do not receive the environment injected by managed artifact workflows. If a standalone build fails while loading its configuration, supply the required artifact runtime context explicitly before treating it as a code failure. Do not infer the public preview path from the directory name; inspect the artifact routing or use the preview resolver.

**Why:** A valid frontend build initially failed at configuration load outside its managed workflow, while the actual browser preview was mounted at root rather than the directory-shaped path.

**How to apply:** For local build checks, distinguish missing workflow-provided environment from compiler errors; for HTTP checks, use the artifact's resolved preview path instead of guessed prefixes.