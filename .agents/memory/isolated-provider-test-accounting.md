---
name: Isolated provider test accounting
description: Prevent cross-scenario mock-call and request-limit interference in isolated provider tests
---

When extending an isolated external-provider integration suite, compare outbound-call counts against a baseline taken immediately before each scenario rather than asserting the whole log is empty. Treat the application's per-user request limiter and the provider's quota ledger as separate independent windows.

**Why:** Adding earlier eligibility scenarios made later consent checks mistake prior mock requests for new disclosures. Rejected requests also counted against the application's per-user limiter even though they never reached the provider.

**How to apply:** For each scenario, take a fresh call-log baseline and assert its delta. Spread or space requests across synthetic users when exercising per-user limits, and reset only the isolated provider-quota fixture where the test explicitly needs a new quota window.