# Development Plan Review: From Goal to Complete Delivery

Plan review asks two things: once every listed task is done, is the goal actually achieved; and are the intermediate states allowed during execution reasonable? Plans cite architecture decisions and organize tasks by delivery responsibility.

## Scope

Pick methods by the conditions below; a narrow review checks only the chosen items and necessary grounds.

| What to check | Method | When |
|---|---|---|
| All tasks done delivers the goal | [Intent alignment](../focuses/alignment.md) and the delivery check below | Default |
| Dependency order and parallelism are feasible | Dependency check below | Default |
| Intermediate states of phased delivery are safe | Transition check below; add [Reliability](../focuses/reliability.md) for explicit failure or interruption audits | Default where real delivery boundaries exist |
| Who owns integration and effective acceptance | Acceptance validity in [Verification](../focuses/verification.md) and the ownership check below | Default |
| Exploration precedes dependent investment | Exploration-order check below | Default |
| Performance facts are verified before decisions that depend on them | [Performance](../focuses/performance.md) and the evidence check below | Triggered: explicit performance review, or architecture, migration, release, or capacity commitments depend on unconfirmed performance facts |
| Avoidable coordination cost | [Maintainability](../focuses/maintainability.md) | Explicit request: simplification or cost audit |
| Verification evidence supports guarantees | [Verification](../focuses/verification.md) | Triggered: explicit verification audit, or verification is due at this stage |

`simplify` checks coordination cost; task count is only structural information. `harden` checks interruption, recovery, acceptance ownership, and verification sufficiency at real delivery stages. Plans describe implementation and verification; experiments run at the stage the plan assigns.

## What Must Actually Be Delivered

Read the original goal, valid architecture decisions, phase scope, and this round's authorization before the task list. A plan cannot drop goals on its own, but explicitly approved phasing and non-goals must be respected.

List the capabilities, dependencies, necessary integration, verification tasks, and transition conditions to deliver, and work back from the goal to find work the author may have missed. Use whatever record format the project needs; no fixed `tasks.md`, task count, file count, or context ratio.

## Does Finishing Every Task Achieve the Goal?

Work back from the result the user finally observes:

```text
user gets the result ← the capability is actually used ← necessary connections are wired ← related work is done
```

Try to construct "every task done as described, yet the goal not met". For example, the API and the web button are each built, but wiring them together is excluded from every task. A clear omission with no other owner can be a defect.

If task descriptions or shared acceptance already include the wiring, the responsibility is assigned. When results and acceptance are clear, internal helper steps are left to implementation.

## Real Dependencies and Parallel Order

Judge from the real preconditions of the work; fields such as `depends_on` are only declarations. Check for using interface contracts before they exist, circular waits, two parties each deciding a shared format, or several executors racing on the same state. A problem needs a concrete ordering the plan allows and its consequence.

Reuse existing globally fixed contracts, shared acceptance, or a named integrator that resolves the order. Whether tasks can run in parallel depends on real preconditions and shared state; overlapping files are only a lead.

## Intermediate States in Phased Delivery

At the end of real delivery phases, and on partial failure, pause, and rollback, check whether old paths remain, how default switches are set, whether old and new parties interoperate, and whether data can recover as agreed. Verify migration order against these intermediate states.

Check only real delivery boundaries. A local atomic change is one delivery unit; availability and data guarantees follow existing requirements.

## Who Owns Integration and Acceptance

Check which task produces verification evidence, who observes the final integrated result, and when the evidence appears. Per [Verification](../focuses/verification.md), try to find a case where every local acceptance passes but the whole fails.

Example: every task accepts only its own output and nobody checks the necessary connections, so the system may end up unusable. When acceptance behavior is clear and ownership assigned, specific test commands can be chosen during execution.

An ordinary plan review may still report a specific wrong acceptance or a clearly missing necessary verification task without the user saying `harden`. Deeper verification-sufficiency audits pick methods per the table above; do not generalize to "more tests is better".

## Exploration Before Investment

Exploration tasks (often called spikes) answer questions that would change the approach. Check what they answer, how results are observed, how different results change later actions, and which dependent tasks cannot start before the answer.

Investigate, then decide, then implement is a sound plan; the unknown belongs to the prior investigation task. If an irreversible migration or large implementation depends on an unconfirmed interface capability while the investigation is scheduled last, point out the real dependency problem.

Budgets and schedules follow user constraints. Splitting suggestions must cite known resource conflicts, serial preconditions, or current delivery requirements; model estimates are only leads.

## Performance Evidence in Time

Per [the plan branch of performance](../focuses/performance.md#plan-get-evidence-before-the-decisions-that-depend-on-it), check who obtains scale and cost evidence before the related investment and who adjusts later tasks based on it. Use static bounds when they suffice; when measurement is needed, check authorization, observation, and judgment per [evidence access](../evidence-access.md) and [Verification](../focuses/verification.md).

## Route Problems to Whoever Can Fix Them

The plan author can fix local dependencies or missing tasks. If a feasible path requires changing approved capabilities, shared responsibilities, interfaces, or guarantees, return it to the relevant architecture or requirements decision. "Ship v1 first" must not quietly drop goals that must be delivered.

When the architecture contradicts itself, keep the original sources and the minimal contradiction; do not ask the plan author to add tasks that implement the impossible.

## Delivery and Re-review

The delivery path for delegated goals, related dependencies, intermediate states, and acceptance ownership each have a conclusion or a concrete limit. Suspicions pass the counter-evidence check; established problems name a handler and completion condition and are delivered per the [shared finding requirements](../findings.md).

A finished investigation means the delegated plan has conclusions, which may include missing wiring or wrong order. These are static conclusions; actual execution and progress must be proven by execution records.
