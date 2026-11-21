# Test Review: Accurate Verdicts and Valuable Detection

Test review checks whether verdicts follow independent contracts and whether tests catch real errors the other tests miss (**independent detection power**). Test count and surface similarity only help locate the investigation.

## Scope and Problem Types

A delta review covers changed test cases, parameter rows, assertions, fixtures, snapshots, mocks, and test helpers, each changed assertion, tests affected by shared fixtures, mocks, or helpers, and production changes that make an existing wrong verdict reachable again. An audit covers the explicitly delegated current test set and marks problems as pre-existing. Missing tests, coverage, or cases alone stay as leads. Three fully proven problems are reported:

| Type | What to prove |
|---|---|
| **T1: false confidence** | The test lets through an error it should catch |
| **T2: change detector** | The test rejects a legitimate change the contract allows |
| **T2: zero-marginal signal** | The test may judge correctly but adds no error detection over the rest, only duplicate failure signals or maintenance points |

The first two are test validity; the third is test economics. A full code review picks branches by the change table below; a narrow review runs only the delegated branch and marks the rest out of scope.

## Investigate Test Changes by Behavior Contract

Read and investigate together by shared behavior contract and production boundary; members only add the differences that affect the judgment. For the current change, establish:

- which guarantee the test owns, where the independent contract is, and at which layer its responsibility stops;
- how input passes through production decisions and side effects into the observed actual result;
- how the test prepares data, obtains the expectation, matches, and decides pass or fail;
- how this change affects that path, and whether related tests can still reject contract violations.

The **oracle** is the test's basis for the correct result; the **verdict** is the final pass or fail. Tracing actual and expected results separately reveals cases where both share a wrong source yet still match.

Input categories and boundaries come from real production conditions and independent contracts. Judge members separately when permissions, identity, state, platform, boundary values, or real paths differ; ordinary name or value changes do not prove different semantics. When shared setup affects several behaviors, follow real calls for each.

The workspace keeps only the evidence and gaps needed to restore the judgment, located by file, test name, and symbol; no IDs, semantic groups, or ledgers per assertion.

## Choose Branches by Change

The table lists the branches a full code review checks; the caller may narrow them. Shapes trigger investigation; problems still need their proof, and changes of unclear purpose are understood first.

| Change | Branches |
|---|---|
| Added or changed cases, parameter rows, assertions, or snapshots | Redundant signal; also distortion and overconstraint when the actual or expected path changes |
| Fixtures, mocks, or helpers change real calls, inputs, or expectation sources | Distortion; overconstraint when an extra verdict property is pinned; redundancy when duplicate verdict signals are added |
| Expectation shares a source with production constants, schemas, formatters, or conversions | Distortion |
| Assertions pin order, whole objects, private fields, exact diagnostics, or call shape | Overconstraint |
| A production change makes an existing wrong verdict reachable again | Distortion |

T1's proof is below. Load the others only when delegated and triggered: [legitimate-change proof](test-overconstraint.md) for T2 overconstraint and [independent detection and deletion proof](test-economics.md) for test economics, each in full.

## Proving T1: The Test Lets Through an Error

Construct the smallest error the test should reject on independent contract grounds and trace both:

```text
wrong input or implementation → production path → actual result
wrong input or implementation → test setup and expectation source → match → verdict
```

An expectation sharing a wrong constant, helper, or conversion with production lets both sides be wrong yet equal; a mock bypassing real permissions, transactions, persistence, or external side effects can also let errors through. Prove that the delegated verdict makes the related test set misjudge, attributed to this change or the audit.

When a mock or stub replaces a lower layer with preset results to check how the caller propagates, maps, or displays them, the test's responsibility usually stops at the nearest unreplaced caller; the lower producer needs its own verification. T1 for bypassing a lower boundary requires a contract independent of the reviewed test that demands the real lower layer run, or proof that this change removed the set's independent real-path check. Test names, canned error text, or mocks only locate the test's responsibility.

## Change Relation and Root-Cause Merging

For each suspicion check whether the difference actually changes validation, path, result, verdict, independent requirement, or test layer; differences in values, actors, or test names must connect to such a change. A delta review checks whether the old version already had the same misjudgment or redundancy and how the change introduced, widened, or re-triggered it.

If a production problem holds and the test merely endorses it, report only the production problem; keep a T finding when the test has its own error cause. T1 and T2 overconstraint are defects; T2 redundancy is an improvement; state the specific type.

Passing tests are one runtime result and do not replace contract and verdict proof. Established findings keep the full proof for their branch, once per root cause.
