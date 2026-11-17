# Architecture Review: Designs That Carry the Goal and Support Collaboration

Architecture review judges whether the design can achieve the user's goal, whether parts that each honor their own contracts combine correctly, who owns state and failure, and whether key trade-offs are sound. Those judgments, not style, decide technology and design choices.

Choose diagrams, layer descriptions, and scenario walkthroughs as the design needs.

## Scope

Pick methods and scenarios by the conditions below; a narrow review checks only the chosen items and necessary dependencies, and scenario walkthroughs happen in the same round.

| What to check | Method | When |
|---|---|---|
| Design supports the original goal | [Intent alignment](../focuses/alignment.md) and the goal check below | Default |
| Parts are correct together | Composition check and scenario walkthrough below | Default |
| State and failure have owners | [Reliability](../focuses/reliability.md) and the ownership check below | Default; by actual contracts, without unrelated failure scope |
| Old and new systems transition and coexist | Evolution check below | Default when an existing system changes |
| Key rationale and decisions hold | Rationale check below | Default; for rationale and trade-offs affecting this decision |
| Runtime and resource cost at realistic scale | [Performance](../focuses/performance.md) and the capacity check below | Triggered: explicit performance review, or the design changes data scale, remote boundaries, concurrency, shared resources, or capacity mechanisms |
| Avoidable change or collaboration cost | [Maintainability](../focuses/maintainability.md) | Explicit request: cost or simplification audit |
| Trust and isolation boundaries hold | [Security](../focuses/security.md) | Triggered: explicit security review, or a security boundary changes |
| Verification supports current guarantees | [Verification](../focuses/verification.md) | Triggered: explicit verification audit, or verification is due at this stage |

`simplify` checks change and collaboration cost; `harden` checks state, failure ownership, and verification sufficiency. Both stay within the delegation; exploration gathers verification evidence only as currently due.

## Current State, Proposal, and Decisions

Read the relevant original requirements, current boundaries, valid decisions, this proposal, and actual dependencies, and separate current implementation, approved goals, and historical rationale. Understanding a local change does not require rebuilding the whole project.

A new design without code or an old version can still be reviewed against goals and mechanisms. Existing code shows the current state; user needs come from the original request and valid decisions; "approved" status is proven by a source the task recognizes.

List the affected capabilities, key decisions, responsibilities, state, external contracts, and the necessary connections between them. Understand system boundaries before entering the services or modules involved; do not treat business goals, deployment units, and internal functions as items at one level. If prose explains it, do not ask the author to redraw diagrams.

## A Real Mechanism for Each Goal

Per [intent alignment](../focuses/alignment.md), map each original scenario to an owner and mechanism in the design, distinguishing identities, historical data, recovery, stages, sub-objects, and consumers as actually needed. A responsibility name or a line on a diagram is only an entry point; support for the goal requires a complete mechanism.

Example: the user requires that edits after a run starts do not affect it. The design pins the main definition but still reads mutable sub-definitions at execution time. Report how editing a sub-definition after start and before use changes the current run; the freeze scope follows this real path and the user's goal.

Before reporting, check whether the user only required pinning the main definition, whether sub-definitions already have immutable references, or whether the behavior was explicitly accepted. Exclude the suspicion if such an explanation holds.

## Do the Parts Still Meet the Requirement Together?

For two parts that must jointly achieve a goal, try to construct:

```text
A honors all its contracts and produces result A.
B honors all its contracts and produces result B.
They interact at the shared boundary as designed, yet the higher-level goal fails.
```

Check shared identifiers, field meanings, state write ownership, ordering, lifecycle, and failure ownership. The parts may be modules, services, migration batches, or parallel tasks — not necessarily two agents.

Internal differences are a composition problem only when they reach the shared boundary and break the goal. Parts that never interact, differences isolated by an adapter, consistent external meaning, or a shared contract scheduled to be settled by a named owner before independent implementation are all explanations to check.

Existing contracts that clearly conflict and cause a violation are a `defect`. When independent implementation is about to start with no mechanism to settle a necessary boundary, raise a `decision` stating the minimum that must be unified. Internal choices not yet due do not become design problems.

## Walk the Design Through Scenarios

Choose scenarios from real goals or consumers that discriminate between designs, and step through entry points, responsibility, persistent state, external guarantees, and final outcome using only mechanisms in the material. Keep the basis for each step; do not let the author invent settings on the spot to rescue the old version.

When a step cannot continue, check in order:

1. Is there a cross-file reference or current contract? Read it.
2. Is it a detail this stage may omit and that is assigned to later implementation? Not a defect.
3. Is a mechanism or decision the goal must rely on now missing? Apply the defect or decision bar.
4. Is the reviewer just unfamiliar with a term? Look it up; it is not the author's fix obligation.

Locate the earliest stuck step to find the root cause. The reporting bar depends on current material impact; distinguish "not yet defined" from "proven wrong".

## State, Failure, and Recovery Ownership

Per [reliability](../focuses/reliability.md), reason about failure orderings from existing contracts and the responsibilities, persistent facts, and mechanisms the design states. Contradictions in the mechanism can be proven before implementation; internal details legitimately left for later follow the stage plan.

A clear guarantee violation can be a defect. If a mechanism relies on an unproven external capability and the next step already depends on it, investigate whether a fact or decision must be settled; do not assume the capability is absent.

## Runtime Cost at Realistic Scale

Per [the architecture branch of performance](../focuses/performance.md#architecture-check-capacity-mechanisms-along-the-design-path), compare path cost with capacity and check the mechanisms and owners for these guarantees. Without an implementation, use known bounds; when measurement is required, record the assumption, needed evidence, and latest stage to obtain it.

## Transition Between Old and New

When an existing system changes, separate the current state, allowed intermediate states, and target state. Along real deployment and data-evolution boundaries, check how supported old and new participants coexist, how existing data migrates, and whether rollback agreements hold. Do not enumerate version combinations the system never supported.

Other active changes on the same subject are leads. When coordination is needed, name the shared premise they change. Judge progress with matching evidence: proposals describe goals, current implementation and deployment records show reality, merged PRs count for what they cover, and cross-PR goals are checked change by change.

## Grounds for Key Trade-offs

For choices affecting boundaries, cost, or follow-on investment, check whether the rationale comes from facts or guesses. Compare with the strongest feasible alternative when needed; do not require three options per choice.

Report only when a wrong premise or missing evidence would change the current choice. A wrong technical choice is proven by a premise or evidence problem affecting this decision; value trade-offs the user has not made return as decisions, and accepted costs within scope keep the original decision.

## Delivery and Re-review

Record each problem's original requirement, owner, scenario or composition, design path and basis, first point of failure, explanations checked, handler, and completion condition. When a higher-level goal or trade-off must change, return only the part this level cannot decide; do not hand the whole investigation log to the user.

The delegated scope is complete when every affected requirement, necessary connection, and important decision has a conclusion and legitimate omissions are identified. Output follows the [finding requirements](../findings.md), naming decisions to handle and key remaining risks; a no-problem conclusion is limited to the checked scope and evidence.
