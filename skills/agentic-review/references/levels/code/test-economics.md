# Test Economics: Independent Detection and Deletion Proof

Complete the shared scope check, behavior investigation, counter-evidence check, and records per [test review](test-contracts.md); this file only adds the delegated test-economics proof.

## Partition Real Inputs Before Choosing Representatives

Partition by real production conditions and contracts before comparing specific values:

| Input | Distinguish first | Differences that usually do not add detection power |
|---|---|---|
| Numbers and lengths | Illegal lower bound, exact boundary, interior value, overflow, saturation, or precision boundary | Ordinary positive values in the same interior range, or ordinary lengths in the same over-limit class |
| Strings and identifiers | Empty, enum, reserved, non-reserved, format, and encoding classes | Swapping an ordinary value under the same non-reserved key |
| Paths and prefixes | Root, match and non-match, traversal, drive letters, platform separators | Different ordinary directory or file names at the same depth and shape |
| Collections | Empty, one, many, duplicates, unordered, limits, and pagination boundaries | Swapping ordinary members at the same size and order semantics |
| State and identity | Unauthenticated, roles, tenants, ownership, preconditions, terminal states, retries | Arbitrary name changes that take no part in permissions, branches, or output |

In a finite set of permissions, identities, or protocols, different members may carry independent error risk; ordinary values outside the set usually share a class. For branchless formulas, inputs can still separate omitted terms, wrong terms, comparison operators, precision, or overflow supported by the production expression or an independent contract.

Boundaries fixed by production validation, data constraints, or protocols have independent value. Judge lower bound, boundary, interior, upper bound, and beyond separately at real dividing points, even when current returns match. A real boundary not previously covered is kept outright; adjacent classes need no invented error. A test named "boundary" with no dividing point in production conditions or the pre-change contract is still ordinary input.

Compare substitutability within groups of the same behavior contract, production boundary, and test layer; members differing in input class, real path, expected verdict, or independent risk are judged separately. Each group picks an existing or minimal representative; members compare only with their group's representative, reusing shared evidence.

## Proving T2 Redundancy: Deletion Loses No Detection

First look for independent detection power, then locate duplication, then prove deletion misses nothing. A retention reason ends the redundancy investigation for that member; other delegated validity branches still run.

This is static deletion analysis only; it does not authorize modifying or running target tests.

### Reasons to keep

Look for independent detection power along:

- **different behavior or boundary**: real validation, a previously uncovered explicit boundary, permissions or ownership, state branches;
- **different environment**: platform, runtime, encoding, or external consumer;
- **different verification responsibility**: genuinely different unit, integration, or contract layers, or an independent verdict basis.

If any of these is statically shown to add value, keep the member and end its redundancy investigation.

Example: the contract and production validation require `count <= 100`; the existing test checks 50 and a new test checks 100. Both pass now, but 100 catches `<=` written as `<`, so it is a new boundary to keep.

### Locating duplicate verdict signals

Without a retention reason, these shapes locate redundancy suspicions for deletion analysis:

- **Duplicate assertions**: one test observes the same state or expression with the same verdict, with no mutation, await, retry, iteration, clock advance, or side-effecting evaluation in between.
- **Identical or renamed tests**: ignoring names, classes, top-level wrappers, and meaningless intermediate variables, setup, call, result, expectation, and input role are the same.
- **Verdict containment**: a whole-object comparison already includes the state field, a whole-collection verdict includes the same members, or the original test already covers the new setup, result, and expectation.
- **Ordinary data substitution**: only ordinary values, names, or locals change; structure, input class, production path, and verdict are the same.
- **Duplicate setup**: same setup is not enough; it is a suspicion only when calls, verdicts, and detectable errors are also the same or contained.

### Deletion analysis

Analyze a group sharing one redundancy cause once, not per member. Assume these members are removed and look for a real, local contract-violating error that the remaining tests pass while a removed member fails. Such an instance proves deletion loses detection power and must connect:

1. which error or behavior boundary violates the requirement;
2. how it reaches the actual result through the production path;
3. why the existing and retained related tests still pass;
4. why the current member fails;
5. that the error comes from a production expression, validation, state machine, external contract, or real risk, grounded independently of the reviewed samples.

Counterexamples may come from the retention reasons above, real concurrency, cleanup, exceptions, terminal states, or omitted fields, terms, wrong mappings, and comparison operators derivable from the production expression. Different names, ordinary values, or fixture descriptions alone do not prove independent value.

Distinguishing tests by specific values, data tables, enum members, or source branches needs corresponding evidence in production code, current production or contract changes, or an independent valid contract. Merely assuming the implementation hard-codes the original test value lacks such grounds; the reviewed tests, assertions, expectations, and notes added with them only locate samples.

Deletion analysis names the retained set, keeping at least one representative per semantic group. With an existing representative, compare the new members; without one, or in an audit, first fix the minimal retained set. Parameterization reduces code duplication; detection power still follows the semantics included.

### Report redundancy only when all hold

1. **Clear coverage relation**: the member's verdict is contained in a retained test, or it matches a representative in responsibility, input class, boundary, production and verdict path, error mode, and layer.
2. **No independent value discarded**: behavior boundary, environment, layer, and verdict-basis differences are checked and no retention reason holds.
3. **Deletion misses nothing**: comparative analysis is done, the retained set is named, and no real error caught before would be missed after.
4. **Duplication has real cost**: the extra failure signals or maintenance points can be named.

All four are required; failing to find a counterexample does not replace the coverage relation and full deletion analysis.

## Merging Redundancy Root Causes

Group redundancy by shared business behavior, input class or boundary, verdict style, detectable errors, and test layer, recorded as a **cluster key** identifying the root-cause group. Different production symbols, business responsibilities, or external boundaries form separate groups; how tests were generated or "duplicates existing coverage" only records where the investigation came from.

Exact copies, renames, ordinary data substitution, containment, and duplicate assertions under one root cause are evidence for a single finding. When a whole test is redundant and also contains duplicate assertions, report the whole test; if the test has independent detection power, report only the truly duplicated assertions.
