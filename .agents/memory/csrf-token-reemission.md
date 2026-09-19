---
name: CSRF token re-emission
description: Why authenticated bootstrap reuses the session's CSRF token rather than rotating it
---

The authenticated current-user bootstrap should reemit the CSRF token already stored in the session, generating one only when the session lacks it. Successful login and registration should still rotate to a new token.

**Why:** Concurrent current-user requests can otherwise generate different tokens and race while saving the session and setting the readable cookie, leaving the cookie and persisted session token mismatched.

**How to apply:** Preserve this distinction whenever authentication bootstrap or CSRF issuance changes: login/register rotate; authenticated page-load recovery reemits.