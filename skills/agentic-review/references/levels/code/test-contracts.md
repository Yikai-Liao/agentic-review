# Test Review: Accurate Verdicts and Valuable Detection

Test review checks whether verdicts follow independent contracts and whether tests catch real errors the other tests miss (**independent detection power**). Test count and surface similarity only help locate the investigation.

## Scope and Problem Types

A delta review covers changed test cases, parameter rows, assertions, fixtures, snapshots, mocks, and test helpers, plus production changes that make an existing wrong test verdict reachable again. An audit covers the explicitly delegated current test set and notes that problems are pre-existing without inventing new attribution.

Missing tests, coverage, or cases alone stay as leads. Test review reports three fully proven problems:

| Type | What to prove |
|---|---|
| **T1: false confidence** | The test lets through an error it should catch |
| **T2: change detector** | The test rejects a legitimate change the contract allows |
| **T2: zero-marginal signal** | The test may judge correctly but adds no error detection over the rest, only duplicate failure signals or maintenance points |

The first two are test validity; the third is test economics. A full code review picks branches by the change table below; an explicitly narrow review runs only the delegated branch and its necessary evidence and marks the rest out of scope.

## Investigate Test Changes by Behavior Contract

A delta review checks every delegated change from the base/head diff, including each changed assertion in a test and tests affected by shared fixtures, mocks, or helpers. An audit checks the delegated current set. Read and investigate together by shared behavior contract and production boundary; members only add the differences that affect the judgment.

For the current change, establish:

- which guarantee the test owns, where the independent contract is, and at which layer its responsibility stops;
- how input passes through production decisions and side effects into the observed actual result;
- how the test prepares data, obtains the expectation, matches, and decides pass or fail;
- how this change affects that path, and whether related tests can still reject contract violations.

The **oracle** is the test's basis for the correct result; the **verdict** is the final pass or fail. Tracing actual and expected results separately reveals cases where both share a wrong source yet still match.

Input categories and boundaries come from real production conditions and independent contracts. Judge members separately when permissions, identity, state, platform, boundary values, or real paths differ; ordinary name or value changes do not prove different semantics. When shared setup affects several behaviors, follow real calls for each; one test's conclusion does not cover different paths.

These are investigation requirements. The workspace keeps only the evidence and gaps needed to restore the judgment, located by file, test name, and symbol; no IDs, semantic groups, or ledgers per assertion. Comparing substitutability and choosing representatives happens only in the delegated test-economics branch.

## Choose Branches by Change

The table lists the branches a full code review must check. An audit picks by the mechanisms of the delegated verdicts; a narrow review takes only the delegated branch. Shapes trigger investigation; problems still need their proof, and changes of unclear purpose are understood first.

| Change | Branches |
|---|---|
| Added or changed cases, parameter rows, assertions, or snapshots | Redundant signal; also distortion and overconstraint when the actual or expected path changes |
| Fixtures, mocks, or helpers change real calls, inputs, or expectation sources | Distortion; overconstraint when an extra verdict property is pinned; redundancy when duplicate verdict signals are added |
| Expectation shares a source with production constants, schemas, formatters, or conversions | Distortion |
| Assertions pin order, whole objects, private fields, exact diagnostics, or call shape | Overconstraint |
| A production change makes an existing wrong verdict reachable again | Distortion |

The caller sets branch scope. T1's proof is below; for T2 overconstraint read [legitimate-change proof](test-overconstraint.md) in full, and for test economics read [independent detection and deletion proof](test-economics.md) in full. Load only branches that are delegated and triggered.

Reuse shared evidence for the same behavior and analyze only each member's differences. Out-of-scope parts do not count as reviewed.

## Proving T1: The Test Lets Through an Error

Construct the smallest error the test should reject on independent contract grounds and trace both:

```text
wrong input or implementation → production path → actual result
wrong input or implementation → test setup and expectation source → match → verdict
```

An expectation sharing a wrong constant, helper, or conversion with production can let both sides be wrong yet equal; a mock bypassing real permissions, transactions, persistence, or external side effects can also let errors through. Prove that the delegated verdict makes the related test set misjudge and confirm attribution to this change or the audit.

Also check which layer the test owns. When a mock or stub replaces a lower layer with preset results to check how the caller propagates, maps, or displays them, the test's responsibility usually stops at the nearest unreplaced caller; the lower producer needs its own verification.

T1 for bypassing a lower boundary requires a valid contract independent of the reviewed test that demands the real lower layer run, or proof that this change actually removed the set's independent real-path check. Test names, canned error text, or mocks only locate the test's responsibility.

## Change Relation and Root-Cause Merging

For each suspicion check the strongest reasonable explanation: does the difference actually change validation, path, result, verdict, independent requirement, or test layer? Differences in values, actors, or test names must connect to such semantic changes to prove independent value.

A delta review checks whether the old version already had the same misjudgment or redundancy and how the change introduced, widened, or re-triggered it; an audit describes the current verdicts and retained set. Both check whether a production finding already covers the root cause. If the production problem holds and the test merely endorses it, report only the production problem; keep a T finding when the test has its own error cause.

T1 and T2 overconstraint are defects; T2 redundancy is an improvement. State the specific type in the output.

## Record and Check Coverage

Work back from the diff or delegated set over every change and shared-setup effect, confirm the chosen branches' necessary investigation is done, and that each suspicion is proven, excluded, or has an explicit evidence gap. Passing tests are one runtime result and do not replace contract and verdict proof.

Reuse existing coverage records and save, per the [shared state rules](../../review-state.md), the key paths, verdict grounds, and exclusion evidence obtained during investigation but absent from public results; keep necessary grounds even without findings. Established findings keep the full proof for their branch, once per root cause; unfinished investigation records the gap and next read location and stays `pending` or `blocked`.
