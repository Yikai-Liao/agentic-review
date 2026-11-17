# Verification: Telling Right from Wrong, and Whether Evidence Suffices

Verification review separates two questions: does acceptance itself judge wrongly, and do the guarantees due now have enough evidence? Verification scheduled for a later stage stays planned until due.

This file offers two methods chosen separately. Conclusions follow the [shared evidence requirements](../findings.md); the name "verification review" does not decide the finding kind.

## Choose the Branch and What Must Be Verified Now

**Acceptance validity** checks whether existing acceptance lets errors through or rejects legitimate behavior; each level's default scope or an explicit request triggers it. **Verification sufficiency** checks whether existing evidence supports current guarantees; it triggers only on explicit request or when the related verification is due.

Grounds come from the original goal, valid decisions, real external contracts, or explicit audit authorization; coverage, test counts, or green CI do not define which guarantees need support.

| Level | How to check |
|---|---|
| Requirements | Would acceptance accept an artifact that fails the real user goal? No tests required yet |
| Architecture | Can scenario walkthroughs, capability experiments, or analysis distinguish the wrong assumptions or mechanisms now relied on? |
| Plan | Do acceptance tasks observe the final capability and necessary connections, and produce evidence before dependent work? |
| Code | Input reaches an actual result along the production path while the test obtains its expectation separately; are errors let through or legitimate changes rejected? |

For each relevant guarantee, establish how it can fail, what protects it, what verification observes, and how it decides. Test distortion or overconstraint in code uses the matching branch of [test review](../levels/code/test-contracts.md), without automatically reviewing test redundancy.

## Proving Acceptance Judges Wrongly

This is a `defect`. Give a real error that satisfies existing acceptance yet violates an independent goal, or a legitimate change that keeps the goal yet is rejected. Locate the actual observation or verdict problem.

Test names, mocks, and implementation complexity only locate the investigation. The conclusion states where the actual result and the expectation each come from, and why the error still passes or the legitimate result fails.

## Proving Current Verification Cannot Distinguish the Error

The `verification-gap` bar is in the [shared evidence requirements](../findings.md). Construct a local error from real validation, state, boundaries, or failure conditions, trace why existing verification cannot detect it, and find the smallest observation that distinguishes it while keeping adjacent legitimate behavior.

Example: before enabling, retry IDs must be verified stable. The implementation generates the ID outside the retry, but the only test runs one successful call. Moving generation into the retry body still passes; observing the IDs of two requests after a lost response checks the guarantee. That is a verification gap; the production implementation is judged separately from current code.

If only architecture exploration is approved and a named task performs valid verification before enabling, the current status is "verification scheduled". An ordinary code review raises a verification-gap finding only with a verification requirement due now and a relevant error existing verification would miss.

## Is It Already Covered Elsewhere?

Read the related original evidence; not finding a test by name does not mean no coverage. Check whether integration or contract tests at other layers catch the same error, whether a mock's responsibility stops at the nearest unreplaced caller, and whether a new observation duplicates an existing signal.

Whether a test at another layer can carry an explicitly required independent boundary check depends on the verification goal and real path. It substitutes only when its observation and verdict cover the same guarantee.

## Static Reasoning Versus Actual Experiments

When experiments or runtime results are needed, follow [evidence access](../evidence-access.md). A statically designed probe is "to run"; target or environment mismatch, execution failure, and timeout are recorded as such; passing requires an actual result matching target and environment.

Mutation testing changes an implementation locally to see whether tests catch the error. A mutation that still passes is a surviving mutant; first rule out equivalent behavior, unreachable paths, irrelevance to the goal, and tool errors before concluding a real miss. Valid mutations come from real mechanisms, boundaries, or error modes, and verification requirements from independent goals. A high score only summarizes the mutations actually run.

## Delivery and Re-review

A wrong acceptance is fixed when the verdict is correct again; a verification gap closes when the relevant error is now effectively distinguished. File and test counts only record the form of the fix.

When a necessary measurement is not yet provided, stay unverified and label static corrections as static evidence. A production violation and the test endorsing it are one root cause, reported once. The round ends when every delegated relationship has a conclusion or concrete limit.
