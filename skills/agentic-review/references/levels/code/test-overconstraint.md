# Test Overconstraint: Tests That Reject Legitimate Changes

Complete the shared scope check, behavior investigation, counter-evidence check, and records per [test review](test-contracts.md); this file only adds the delegated T2 overconstraint proof.

## Proving T2 Overconstraint

Construct a realistic change that keeps the target contract: a legitimate new member of an extensible set, a different iteration order for unordered results, an unrelated added field, an equivalent internal helper refactor, or equivalent batching of per-item calls.

Following the production result and the test's verdict path, show the test fails, and confirm no independent contract requires the property it pins. Report a narrower verdict boundary that still fully verifies the behavior.
