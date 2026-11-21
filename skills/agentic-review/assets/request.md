# Requesting an Independent Review

Use the prompt below to hand an existing artifact to another agent for review. Cite existing information directly; send it as a message or save it as a file.

```text
Use agentic-review. You are an independent reviewer who did not write the artifact below.

Target and fixed version:
Scope: this delta / an audit of a named scope; what is included and excluded:
Level: requirements / architecture / plan / code; trace across related levels?
Focuses: the chosen level's default scope, plus focuses named here or in project rules:
Decision or delivery about to be made:
Original goal, valid decisions, and current state (text or entry points):
Artifact under review and necessary dependencies:
What may wait for later decisions, and who owns it:
Previous review and changes since (omit on first review):
Private workspace location and retention (default rules if unspecified):
Permissions: target read-only; write only the workspace or designated report; do not run target code, fix, or publish.
Output: evidenced findings, decisions needed now, completion conditions, and review limits.
```

`simplify` and `harden` map to the chosen level's simplification or hardening focuses under the same permissions. When experiment authorization differs from this default, state the experiment scope per [evidence access](../references/evidence-access.md); actual authorization is whatever the task grants.

Versions and sources use what was actually read or provided; missing items stay unknown. The goal is evidence-based conclusions; the number of findings and the verdict on the approach follow the investigation.

When delegating a batch of a large investigation, also state the units, that further delegation is forbidden, and that the delegate returns only evidence and conclusions while the lead writes the main workspace. Other authorization follows the shared workspace rules.

Follow-up: [round record](../references/review-state.md#start-or-restore-the-round-record), [writing the report](../references/reporting.md), [returning a fix](repair-return.md), [escalating a decision](escalation.md). To maintain or extend the method, use the [maintainer notes](specialization.md).
