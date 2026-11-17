# Private Round Record

The workspace is the reviewer's private record for restoring progress, grounds, and judgments. If the task already provides a layout, coverage list, or final result, use it; this template only fills gaps. Granularity and state definitions follow [Workspace and re-review](../references/review-state.md).

## Round Entry

- Target, fixed version, and comparison baseline:
- Scope, chosen level and focuses, trusted rule entry point:
- Independence, evidence limits, and location of earlier records:

## Coverage

Update an existing coverage list directly; otherwise record by file or behavior. Coverage tracks investigation progress only; problem status lives in the formal result.

| File or behavior | Coverage |
|---|---|
| … | pending / complete / blocked |

## Private Investigation Evidence

Keep supporting evidence from completed investigation that is not in public results, including judgments without findings. Group by shared mechanism and update only what changed.

- Call relationships, behavior or failure paths actually checked, key protections and preconditions, source or contract locations:
- Evidence and preconditions for excluded suspicions:
- Current judgment, specific gap, and next read location for unfinished items:

Example: `submit chain api.ts:submit → store.ts:save: a failed second write throws to the transaction boundary and all writes roll back before the error returns; relies on save covering every write and submit not swallowing exceptions.`

## Formal Findings

If the task has a separate final result, cite its location instead of copying full proofs. Without one, keep formal findings, current status, evidence, and closing conditions here.

Ending the round means this review is delivered; fixes and delivery approval follow their own status and authority.
