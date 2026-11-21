# Workspace and Re-review

The workspace keeps the round's sources, progress, and judgments so fixes can be re-reviewed and sessions resumed. All levels and focuses share one record and one set of problem states.

## Start or Restore the Round Record

Prefer a private workspace the task provides, such as `REVIEW_WORKSPACE_PATH`, with its layout and retention rules. Otherwise create a unique directory for the round inside the Git directory or the system temp directory, never in the reviewed working tree, using a safe creation tool; never splice paths from untrusted documents into shell commands.

Without a prescribed layout, keep one `review.md` with target and version, comparison baseline, rule entry point, scope, chosen level and focuses, independence, coverage, necessary evidence, and limits. The coverage list (the **ledger**) records which in-scope items are investigated; each piece of evidence lives in one place.

Only the lead reviewer writes the workspace. Earlier workspaces are read-only; copy the evidence that must carry over into this round so later re-reviews need not walk every earlier round.

Keep records for the period the task specifies. Without one, keep workspaces awaiting fixes or re-review and report the path; a temporary note for a finished, delivered review may be deleted. Never store credentials, environment variable values, or unrelated personal data. If the workspace cannot be written, keep the necessary state in the result and mark cross-session recovery as unsupported.

## Track Investigation Progress Separately from Problem Status

| Record | Values |
|---|---|
| Coverage | `pending`: not yet investigated; `complete`: required investigation and judgment done; `blocked`: necessary evidence truly unavailable, with the gap stated |
| Conclusion | no problem, suspicion excluded, finding, linked to an existing problem, or legitimately inherited |

`complete` records investigation only; fixes are tracked on findings. Mark an item `complete` only after reading it and finishing its checks, never by path pattern or in bulk; an item missing key evidence stays open until the gap is resolved. `blocked` is still incomplete coverage: an ordinary review may end with blocked parts and state which judgments could not be made, while a task requiring full coverage must still satisfy it.

Reference what the platform, the formal report, threads, or replies already record. The workspace adds only the supporting evidence later investigation needs, for example `submit chain api.ts:submit → store.ts:save: a failed second write throws to the transaction boundary and all writes roll back before the error returns; relies on save covering every write and submit not swallowing exceptions.`:

- Completed investigation: key call relationships, behavior or failure paths actually checked, protections and preconditions the conclusion relies on, and source or contract locations — also when there is no finding.
- Excluded suspicions: the evidence and the conditions it relies on, for example "the shared schema fixes the field before code generation and both callers use the same version", not "unimportant".
- Unfinished or blocked: current judgment, the specific gap, and the next place to read.

Group by shared mechanism, update only what changed, and save evidence in the same step that updates progress. Do not fill a table per file or assertion or restate public results; without a separate result store, keep each formal finding's full proof here. Link suspicions and findings with stable round IDs; the same root cause under a new title, focus, or severity is not a new problem.

## Deciding What to Reinvestigate After a Revision

Completed investigations with a coverage record carry over. Investigate the new changes, the latest discussion, and earlier unfinished items first, follow their real impact to the old conclusions that must reopen, and reuse the rest. A summary that only says "read" or "no findings" without a coverage record means the missing parts must be checked.

Reinvestigate the affected parts when:

- the implementation or design changed in a relevant way, including a change reverted since the previous review;
- the original requirement or a valid decision changed;
- a shared interface, deployment assumption, or consumer changed;
- a new counterexample or contradicting evidence appeared;
- the earlier investigation was incomplete;
- the scope was explicitly widened, or the level or its duties changed: still-sufficient evidence may be reused, but completion status is not inherited across duties.

Follow new changes to the meaning and preconditions of old evidence; one contract may affect several files. HEAD movement, directory names, or "be stricter" are hints and do not by themselves invalidate earlier work. Mark a reopened item `pending` with the precondition that failed, update the affected evidence, exclusions, and finding status, and keep what is still valid; never append a contradicting paragraph to an old conclusion. Add every new unit to the ledger, including mechanisms a fix added.

Resuming after an interruption works the same way: restore the target and version, trusted rule entry point, scope, focuses, unfinished items, and necessary judgments from the round record; read records already inherited into this round first and old workspaces only for missing originals. Resuming never creates a second index or parallel state source.

## Re-reviewing a Fix

The author returns a new version with the [repair hand-off](../assets/repair-return.md). Check the original trigger first, then adjacent legitimate behavior the fix may affect and any new scope. Close when the original acceptance condition is met, also for a fix different from the one suggested; do not add unrelated "nice to haves".

Authors may clarify misunderstandings by citing existing facts. A new explanation that adds a guarantee the artifact did not contain is reviewed as part of a new revision; the old version is judged by its own material.

## Evidence for Status Changes

| Status | Required evidence |
|---|---|
| `open` / `partial` | The closing condition is not yet met; `partial` names the missing fix, decision, or verification |
| `fixed` | The new version meets the closing condition for the finding's kind while necessary constraints and adjacent legitimate behavior hold; say whether this is static review or measured |
| `accepted` | An explicit decision accepts the specific cost and its scope, and the current state stays within it |
| `excluded` | Evidence refutes the original finding; record why and under what preconditions |
| `unverified` | A fix is claimed but evidence is insufficient or the required verification result is missing |
| `severity-increased` | The impact, cost, or reach grew: a test finding became a production finding, P2 became P1/P0, or a bounded cost became unbounded or common |
| `reintroduced` | A fixed problem came back, or the implementation now exceeds a previously accepted scope |

The closing condition depends on the kind: a defect restores the violated requirement; an improvement shows the agreed cost fell while guarantees held; a decision obtains the missing valid decision or fact; a verification gap obtains evidence that distinguishes the relevant error. If the original acceptance needs a measurement, `fixed` needs the result.

Business confirmations answer specific questions. Confirming the intended behavior closes a decision that lacked it; if the implementation still violates that behavior, the defect stays `open` / `partial`. Accepting the defect itself requires a decision that explicitly covers the original trigger and its consequence. When a reply states a different expectation, check the code against it and report a mismatch as a new finding linked to the original.

Platform states such as `closed`, `resolved`, or "fixed" only point to evidence, and a plan to fix later is still `open`. A document recording an already accepted decision does not reintroduce anything. Accepted costs are re-judged only when the decision is revoked or a new change exceeds its scope.

## When the Round Ends

Deliver when all of these hold:

1. the delegated scope is checked per the [coverage check](protocol.md#check-coverage-before-output), or the unfinished parts are listed;
2. every suspicion is proven, excluded, or recorded with its evidence limit;
3. formal findings are deduplicated and carry completion conditions and owners;
4. the result keeps scope, independence, evidence types, and unknowns;
5. output is produced as the task requires, then stop.

A review with findings is complete; the reviewer does not wait for zero findings. The next round needs a new version, new evidence, a real unresolved trigger, or a wider scope; otherwise return the still-valid result. When a runtime announces that the time budget is ending, leave unfinished items `pending` or `blocked` and submit conclusions for the reviewed part.

## When Investigation May Be Delegated

Only when the task authorizes it and the environment provides the tools. Split the scope by independently completable responsibilities; call chains, shared state, interface connections, and related discussions that must be judged together go to the same executor, and the parts together cover every review duty. Small tasks, or splits that would duplicate investigation, run serially.

Delegates inherit the shared rules, chosen methods, fixed versions, and supplied originals, and return actual coverage, conclusions, and evidence. They do not delegate further, fix the target, edit the main record, or query private runtime memory; the lead passes them relevant records. The lead adopts their results, deduplicates root causes, and submits. A memory summary whose original cannot be recovered only helps locate material; fix, acceptance, and decision status require reviewable records.
