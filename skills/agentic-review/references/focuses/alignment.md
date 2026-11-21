# Intent Alignment: Did the Goal Drift in Translation?

Intent alignment checks whether the user's goal was dropped, replaced, or changed without consent as it moved from the original request into requirements, architecture, plans, or code. It applies to a single artifact or along one relationship across levels.

## Trace from the Original Scenario to the Current Artifact

Identify the conditions under which the delegated goal applies and the outcome it must keep, then see how the artifact implements or translates it. Pick a concrete scenario the original sources allow, check where the goal is lost, widened, or narrowed, and whether a valid decision supports that change.

| Level | How to trace |
|---|---|
| Requirements | Do users, scenarios, scope, and exceptions faithfully express the original request? |
| Architecture | Do real owners, mechanisms, and connections support the goal? |
| Development plan | Once every task is done as described, does the capability due now exist, including integration and use? |
| Code | Does real input reach the agreed outcome along state, call, and consumer paths? Prove with code behavior |

Find the earliest point where the goal's meaning changed and state the observable consequence. Later plans, code, and tests agreeing with each other only show they adopted the same goal; changing the goal needs a valid decision. Once a new goal is explicitly approved, judge against it.

Example: the user requires that edits to sub-definitions after a run starts do not affect it, but the design pins only the main definition and keeps reading mutable sub-definitions. Without another immutable reference, an edit after start changes the current run. If the user explicitly asked only for pinning the main definition, exclude the suspicion.

## Reasonable Explanations

Check approved phase scope, explicit non-goals, existing mechanisms, assigned responsibilities, and permitted implementation choices. Goal drift is proven by a change in meaning and its consequence; wording, requirement numbering, and document length only help locate expression. Legitimate details left for later follow the stage plan.

A specific unauthorized violation is proven as a `defect`. When the next step depends on an unsettled scope choice, raise a `decision` stating what must be decided; missing evidence is never written up as a settled goal reduction.

## Across Levels and on Re-review

Read the levels along the goal's actual path within the delegated scope, and locate each problem at the first requirement or mechanism that needs fixing. When upstream has a new valid decision, update the affected expectations. A re-review closes when the original requirement is restored or an explicit scoped decision exists.
