---
name: Uploaded-media identity
description: Security rule for shared upload filenames and legacy message attachments
---

An uploaded file must have one unambiguous current asset reference before any authorization rule grants its bytes. Never select the first authorized record when multiple asset types can reference the same path. A message-linked legacy attachment can be valid without newer claim/channel metadata only when the linked message exists, is live, and its current channel access is checked.

**Why:** A permissive avatar reference to the same path as a private attachment would otherwise bypass the latter's channel or deletion checks; requiring only modern metadata would hide valid older attachments.

**How to apply:** When changing upload schemas, routes, or permissions, regression-test shared-path collisions and old records against revocation and deletion with an isolated database. Fail closed on ambiguity rather than treating possession of a URL as permission.