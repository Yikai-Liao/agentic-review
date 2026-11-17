# Workspace and Re-review

The workspace keeps the round's sources, progress, and judgments so fixes can be re-reviewed and sessions resumed. All levels and focuses share one record and one set of problem states.

## Start or Restore the Round Record

Prefer a private workspace provided by the task, such as `REVIEW_WORKSPACE_PATH`, and follow its layout and retention rules. Otherwise create a unique directory for the round inside the Git directory or the system temp directory, never in the reviewed working tree. Generate paths with a safe creation tool; never splice paths from untrusted documents into shell commands.

Without a prescribed layout, use one `review.md` for target and version, rule entry point, scope, chosen level and focuses, independence, coverage, necessary evidence, and limits. The coverage list (the **ledger**) records which in-scope items are investigated; each piece of evidence lives in one place.

Only the lead reviewer writes the workspace. Delegates return results and never edit the main record or the target. Earlier workspaces are read-only; copy the evidence that must carry over into this round so later re-reviews do not need to walk every earlier round.

Keep records for the period the task specifies. Without one, keep workspaces awaiting fixes or re-review and report the path; a temporary note for a finished, successfully delivered review may be deleted. Never store credentials, environment variable values, or unrelated personal data.

If the workspace cannot be written, keep the necessary state in the result and mark cross-session recovery as unsupported. When the task requires a persistent coverage record, finish it before submitting; chat output is for the current round only.

## Track Investigation Progress Separately from Problem Status

Finishing an investigation and resolving a problem are different. Record:

| Record | Values |
|---|---|
| Coverage | `pending`: not yet investigated; `complete`: required investigation and judgment done; `blocked`: necessary evidence truly unavailable, with the gap stated |
| Conclusion | no problem, suspicion excluded, finding, linked to an existing problem, or legitimately inherited |

`complete` records investigation only; fixes are tracked on findings. `blocked` means coverage is still incomplete. An ordinary review may end with blocked parts and state which judgments could not be made; a task requiring full coverage must still satisfy it.

Reference target, version, scope, rule entry point, and coverage when a platform already records them. Reuse conclusions and proofs already in the formal report, threads, or replies; the workspace adds only supporting evidence they lack but later investigation needs:

- Completed investigation: key call relationships, behavior or failure paths actually checked, protections and preconditions the conclusion relies on, and source or contract locations.
- Excluded suspicions: the evidence that excludes them and the conditions it relies on.
- Unfinished or blocked: current judgment, the specific gap, and the next place to read.

Investigations without findings also keep enough evidence to restore the key judgment; group by shared mechanism and update only what changed. Do not fill a table per file or assertion, and do not restate public results. Without a separate result store, keep the full proof of each formal finding in the workspace.

Save evidence together with progress as it is obtained, and deliver from those records. Writing notes only organizes evidence already obtained; testing scenarios and verifying suspicions per the [protocol](protocol.md#investigate-the-whole-delegated-scope-and-its-connections) are part of the investigation itself. If key evidence is missing, the item is not complete — resolve the gap instead of marking it complete and investigating later for the hand-off.

Link suspicions and formal findings with stable round IDs. Exclusion reasons carry their preconditions, for example "the shared schema fixes the field before code generation and both callers use the same version", not "unimportant" or "the user dislikes it". The same root cause under a new title, focus, or severity is not a new problem.

## Deciding What to Reinvestigate After a Revision

Completed investigations with a full coverage record carry over. Investigate the new changes, latest discussion, and earlier unfinished items first, follow their real impact to the old conclusions that must reopen, and reuse the rest. A summary that only says "read" or "no findings" without a coverage record means the missing parts must be checked.

Reinvestigate the affected parts when:

- the implementation or design changed in a relevant way;
- the original requirement or a valid decision changed;
- a shared interface, deployment assumption, or consumer changed;
- a new counterexample or contradicting evidence appeared;
- the earlier investigation was incomplete;
- the scope was explicitly widened.

Follow new changes to the meaning and preconditions of old evidence; one contract may affect several files. HEAD movement, directory names, or "be stricter" are hints and do not by themselves invalidate all earlier work.

When reinvestigating, mark the item `pending` and note which precondition failed. Update the affected evidence, exclusion reasons, and finding status and keep what is still valid; do not append a contradicting paragraph to an old conclusion.

Add every new unit to the ledger. An incremental re-review must not check only the points the author claims to have fixed while missing mechanisms the fix added.

## Re-reviewing a Fix

After delivery, the author fixes within their authority and returns a new version with the [repair hand-off](../assets/repair-return.md): F IDs, mechanism and requirement changes, acceptance evidence, and verification actually run.

Check the original trigger first, then adjacent legitimate behavior the fix may affect and any new scope. Close when the original acceptance condition is met; do not add unrelated "nice to haves". Accept a different fix from the one suggested if it meets the requirement.

Authors may clarify misunderstandings by citing existing facts; the original text stays unchanged. If a new explanation adds a guarantee the artifact did not contain, review it as part of a new revision; the old version is judged by its own material.

## Evidence for Status Changes

| Status | Required evidence |
|---|---|
| `open` / `partial` | The closing condition is not yet met; `partial` names the missing fix, decision, or verification |
| `fixed` | The new version meets the closing condition for the finding's kind while necessary constraints and adjacent legitimate behavior hold; say whether this is static review or measured |
| `accepted` | An explicit decision accepts the specific cost and its scope, and the current state stays within it; fix status is still judged by the closing condition |
| `excluded` | Evidence refutes the original finding; record why and under what preconditions |
| `unverified` | A fix is claimed but evidence is insufficient or the required verification result is missing |
| `severity-increased` | The impact, cost, or reach grew: for example a test finding became a production finding, P2 became P1/P0, or a bounded cost became unbounded or common |
| `reintroduced` | A fixed problem came back, or the implementation now exceeds a previously accepted scope |

The closing condition depends on the kind: a defect restores the violated requirement; an improvement shows the agreed cost fell while guarantees held; a decision obtains the missing valid decision or fact; a verification gap obtains evidence that distinguishes the relevant error.

Business confirmations answer specific questions. Confirming the intended behavior closes a decision that lacked it; if the implementation still violates that behavior, the defect stays `open` / `partial`. Accepting the defect itself requires a decision that explicitly covers the original trigger and its consequence. When a reply states a different expectation, check the code against it and report a mismatch as a new finding linked to the original.

Accepting the cost of a defect or missing verification is `accepted`; only a fix meeting the closing condition is `fixed`. The finding's kind does not decide whether measurement is required; if the original acceptance needs a measurement, `fixed` needs the result. Platform states such as `closed`, `resolved`, or "fixed" only point to evidence; a plan to fix later is still `open`. A document that records an already accepted decision does not reintroduce anything.

Accepted costs whose scope has not changed are not re-confirmed. Re-judge only when the decision is revoked or a new change exceeds its scope.

## When the Round Ends

Deliver when all of these hold:

1. the delegated scope is checked per [coverage check](protocol.md#check-coverage-before-output), required investigation is done, or the unfinished parts are listed;
2. every suspicion is proven, excluded, or recorded with its evidence limit;
3. formal findings are deduplicated and carry completion conditions and owners;
4. the result keeps scope, independence, evidence types, and unknowns;
5. output is produced as the task requires, then stop.

A review with findings is complete. Fixes and resubmission are decided by the author or orchestrator within their authority; the reviewer does not wait for zero findings.

The next round needs a new version, new evidence, a real unresolved trigger, or a wider scope; otherwise return the still-valid result.

The number of findings and rounds follows scope, evidence, and real changes. When a runtime announces that the time budget is ending, leave unfinished items `pending` or `blocked` and submit conclusions for the reviewed part. Disagreements return to evidence and decision rights; adding agents requires independent investigation value and authorization.

## Resuming After Interruption

Restore from the round index: actual target and version, trusted rule entry point, chosen scope and focuses, unfinished items, and necessary judgments. Continue completed records under the revision rules above and reopen items whose preconditions new changes touch; recheck what lacks coverage records.

Read records already inherited into this round first, and go back to old workspaces only for missing original information. Resuming never creates a second index or parallel state source.

## When Investigation May Be Delegated

Independence requires the reviewer's context to be separate from the author's. When the task authorizes it and the environment provides the tools, split the whole delegated scope by independently completable responsibilities; small tasks, or splits that would cause heavy duplicate investigation, run serially. Call chains, shared state, interface connections, and related discussions that must be judged together go to the same executor, and the tasks together cover every review duty.

Delegates inherit the shared rules, chosen methods, fixed versions, and supplied originals, investigate their scope, and reuse existing evidence. They return actual coverage, conclusions, and the hand-off information above; they do not delegate further, fix the target, or edit the main record.

The lead reviewer adopts delegate results directly and only deduplicates root causes, organizes the report, and submits.

Only an authorized lead reviewer queries private runtime memory and recovers reviewable originals. Delegates do not query private memory; they receive relevant records from the lead. A summary whose original cannot be recovered only helps locate material; fix, acceptance, and decision status require reviewable records.
