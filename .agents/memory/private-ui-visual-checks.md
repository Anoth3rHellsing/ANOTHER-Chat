---
name: Private UI visual checks
description: Scope and limitations of styling previews when no authenticated session is available
---

For private surfaces, a synthetic browser fixture can render and exercise the actual UI component (including click-driven dialogs and state changes) without logging into or modifying the owner's account.

**Why:** The normal preview starts at login. A screenshot of that screen cannot establish how an authenticated component behaves. Browser-only fixtures permit interaction checks without touching owner data, but they do not prove the integration or access control.

**How to apply:** Use synthetic fixtures to check rendering and local interactions; pair them with isolated API tests using disposable accounts to verify actual server visibility and authorization. Clearly distinguish component checks from end-to-end authenticated behavior in the report.