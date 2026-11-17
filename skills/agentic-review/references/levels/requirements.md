# Requirements Review: Understanding and Completing What to Build

Requirements review covers users, scenarios, goals, constraints, scope, exceptions, and acceptance. It checks whether the written requirements are faithful to the user and looks for omissions, contradictions, and trade-offs that need clarifying; architecture and implementation belong to later stages.

Grounds come from the user's own words, real scenarios, external constraints, and explicit decisions. When the original request is ambiguous, point out which choices would change the outcome and leave preferences to the user.

## Scope

Pick methods by the conditions below and investigate around the affected requirements; "only review X" covers X and its necessary grounds.

| What to check | Method | When |
|---|---|---|
| Intent and scope faithfully expressed | [Intent alignment](../focuses/alignment.md) and the scenario check below | Default |
| Requirements conflict, trade-offs explicit | Consistency check below | Default |
| Acceptance would accept a wrong outcome | Acceptance validity in [Verification](../focuses/verification.md) and the example below | Default; no measurement required yet |
| Assumptions and decisions support the next step | Assumption check below | Default |
| Performance targets and acceptance support the next step | [Performance](../focuses/performance.md) and the target check below | Triggered: explicit performance review, or scale, capacity, latency, or resource bounds change |
| Unnecessary implementation constraints | Solution-constraint check below | Explicit request: simplification or constraint-cost audit |

`simplify` checks unnecessary solution constraints at this level while keeping user goals. `harden` checks exceptions, guarantees, acceptance, and necessary decisions that are actually relevant, with failure scope drawn from real scenarios. For explicit security requirements, use the scenario and consistency methods on identities, resources, and allowed or forbidden operations; implementation security is proven at design or code level.

## Decide What Must Be Settled Now

List the affected user outcomes, scenarios, constraints, scope decisions, and acceptance, and work back from the original request to find omissions. Separate user needs, author assumptions, proposed decisions, and decisions already in force.

Exploration may keep hypotheses open, but it must say what evidence would change the choice and when the answer is needed. When scope is being fixed or handed to implementation, choices affecting goals and acceptance must have an owner.

Technical approach, interface formats, and internals usually wait for later stages; they belong to requirements only when they are already external constraints. Record legitimate stage splits with their due dates.

## Intent and Scope Drift

Per [intent alignment](../focuses/alignment.md), compare the user's original scenarios with the conditions in the requirements. Check whether different users, times, identities, historical data, and exceptions are still supported, and locate the clause or scope decision; later design supplies the implementation path.

Example: the user needs to record entries offline, but the written requirement only promises online submission. A real no-network scenario shows the goal was dropped. Before reporting, check whether the user explicitly agreed to online-only for this phase or another delivered mechanism handles offline recording. If so, judge by the approved scope and do not restore a goal the user gave up.

## Conflicting Requirements in One Scenario

Try to find one legitimate scenario where two requirements demand conflicting outcomes. Confirm they apply to the same object, time, and conditions; different rules for different roles or stages are not automatically a contradiction.

Example: the same data must be irrecoverably deleted on expiry and also restorable at any time after deletion; both cannot hold in the same scope. If only online copies must be deleted and time-limited backups are explicitly allowed, judge by that agreement and do not impose a stricter meaning of deletion.

Conflicting settled requirements can be a `defect`. Mutually exclusive options listed in a document are still pending choices; when the next step already depends on the choice, raise a `decision` stating who must decide which cost.

## Acceptance That Lets Wrong Outcomes Through

Acceptance validity asks whether an artifact could pass every acceptance check without meeting the user's goal. At this level, reason with a hypothetical artifact; no runnable test is required. See [Verification](../focuses/verification.md).

Example: the goal is "after a failure the user knows what to do next", but acceptance only requires showing a message. Always showing "operation failed" passes yet does not let the user tell whether to retry or fix the input. This holds only if the goal truly needs that distinction; the fix adds the necessary behavioral distinction and leaves HTTP codes or UI to later design.

Also check the reverse: whether acceptance rejects outcomes that meet the goal. Exact wording, page counts, or tool names may come from real brand, legal, or accessibility constraints; check those before suggesting removal.

A specific wrong acceptance is proven as a defect. If the review asks whether verification evidence due now is sufficient, apply the separate `verification-gap` bar; the absence of tests is only a lead.

## Assumptions Behind the Next Step

Separate facts, product hypotheses, and value choices. Say which follow-on investment or scope decision depends on an unknown and how different answers change the goal or acceptance. Read what existing material can answer; do not hand ordinary investigation to the user.

Example: a scope plan assumes "all target customers are online", but existing scenarios include offline staff; resolve the factual conflict first. Return the smallest decision question only when the target user group itself is undecided and the choice changes this phase's goal.

"Interview first, then decide scope" is a reasonable exploration plan; authorized exploration may continue until results arrive.

## Performance Targets Due Now

Per [the requirements branch of performance](../focuses/performance.md#requirements-set-targets-without-prescribing-implementation), check whether the scale, capacity, deadlines, or resource bounds the next step depends on are sufficient for the decision and acceptance. Targets the user explicitly relies on are requirements; batch sizes, caches, indexes, and concurrency usually wait.

## Unnecessary Solution Constraints

Use only when simplification or cost audit is explicitly requested. Pick a real delivery or requirement revision task and show that an implementation rule has no independent goal basis yet adds known cost or rules out a cheaper approach that keeps the goal.

Example: only a standard file export is needed, but a dedicated editor is required. If existing export meets every confirmed goal and the editor adds delivery responsibility, raise an `improvement`. If the user really needs in-editor interaction, the alternative does not keep the goal and cannot prove the constraint unnecessary.

Give the feasible alternative with migration and communication costs and name the goal basis the constraint lacks. Requirement cost is measured by real delivery responsibility; the simplification must keep legitimate scenarios. Removing conflicting requirements still needs a decision from someone with authority.

## Delivery and Re-review

Per [finding requirements](../findings.md), each problem keeps its source, clause or omission location, concrete scenario, the reasonable explanations checked, owner, and completion condition. Unknowns stay unknown; do not choose preferences for the user.

Handling is complete when the goal is restored, acceptance gains the needed distinction, an explicit scoped decision is obtained, or evidence refutes the suspicion. Requirement length and precision follow what the goal needs. Conclusions cover the delegated requirements review; design, implementation, and product value are verified at their own stages.
