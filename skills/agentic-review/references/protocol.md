# Shared Investigation Protocol

All levels share these requirements; the chosen level and focuses supply the specific methods. Reuse existing evidence and add only the material and steps the current judgment still lacks.

## Fix the Target and Scope

Record the target and its version: a commit for code; a revision, saved text, or content hash for documents — anything that lets a later reader recover the same material. When the target changes, either finish the old version or reinvestigate the affected parts, but never combine evidence from two versions into one conclusion.

Distinguish two scopes:

- **Delta review**: problems introduced, widened, or re-triggered by this change, plus whatever a new proposal is about to settle. Say how each finding relates to the change.
- **Audit**: the current state of an explicitly named scope. It may report existing problems but must not claim this change introduced them.

Also pin down the decision or delivery at stake, the chosen level and focuses, original sources, permissions, output requirements, and available history. Judge new proposals directly against the original goal. Keep going where information suffices; ask only when a gap would change the judgment, and keep the delegated scope.

## Establish What This Stage Must Satisfy

### Find sources independent of the artifact

Read the user's words, valid decisions, and real usage first, then interfaces, data agreements, and actual callers. Behavior the artifact must honor on independent grounds is a **contract**: call conditions, return values, retention rules, and so on. When reviewing requirements themselves, judge from the original request and real scenarios.

Existing code and system baselines describe the current state; author summaries help locate material. Code, tests, and comments written together share assumptions and cannot vouch for each other; expected behavior must come from user goals, valid decisions, or external contracts.

**Independent sources can be current decisions.** An explicit business decision can change the expectation; its validity follows the source rules given by the task. When sources conflict, quote both with their scope and explain the practical consequence of each reading.

When history affects the expectation, attribution, or problem status, obtain the original records per [Related records and known issues](known-issues.md).

### Decide which requirements are due now

For each relevant requirement, find who needs what result under which conditions, who owns it, and the latest stage by which it must be settled. The key question: does the decision or delivery at hand already depend on the answer? Separate what must be settled now from implementation details that remain free.

For example, investigating an API's capability before choosing a design leaves the unknown with a prior task; running an irreversible migration before confirming the capability it relies on is a dependency gap.

### Turn unknowns into concrete limits

Separate facts supported by the source, inferences from them, and what is still unknown. For each gap, say what is missing and which choice it would change: investigate what reading can resolve, keep a concrete question for trade-offs the user must make, and do not fault what may legitimately wait. Do not invent metrics, priorities, attacker capabilities, or future requirements for the user.

## Investigate the Whole Delegated Scope and Its Connections

Split the scope into units that can be judged separately — a requirement, an interface, a state change, a group of related code. Include additions, changes, deletions, relaxed constraints, and moved responsibilities, and work back from the goal to find work the author did not list.

Units resting on the same mechanism and sources share reading and evidence; findings are grouped by root cause.

Understand how the current design works before testing it with scenarios. For each unit you should be able to state:

1. what this stage requires and on what grounds;
2. which rule or mechanism satisfies it, or which necessary piece is missing;
3. which real scenario, input, ordering, change task, or acceptance result tests it;
4. who would observe what material impact;
5. which protections were checked, which choices were legitimately open, and what still lacks evidence.

Investigate new, changed, or relied-upon protections actively. For example, after a retry is added, check directly that the relevant failure orderings keep the operation's semantics. Level methods supply specifics; reuse sufficient evidence for the same mechanism.

Risk ordering changes the investigation order, not the scope. Done means every relevant unit has a conclusion; exploration and focused scopes are bounded by the delegation. Mechanical changes may note why no further analysis is needed; out-of-scope content stays unreviewed.

Keep tracing while the necessary path is readable. When material is truly unavailable, note the evidence checked, the gap that affects the judgment, and the next read or observation needed; the mechanism stays unknown. A serious out-of-scope problem found during a narrow review may be flagged separately without changing the review's coverage.

## Verify Suspicions and Conclude

A suspicion is a possible problem not yet proven. Decide whether it holds using [Evidence requirements for findings](findings.md), then add the domain evidence of the chosen method. Locate the first rule, mechanism, or omission that fails, state the consequence, and do not derive several findings from one gap.

Actively look for explanations that refute the suspicion — the **counter-evidence check**. Start with what is most likely to overturn it: upstream or downstream protection, real input limits, decisions assigned to a later stage, accepted costs, problems already present in the old version, and the cost of the alternative. When excluding a suspicion, keep the reason and the conditions it relies on; a recurring suspicion reuses that record. Without a protection found, keep investigating until the bar is met or the limit is explicit.

When a protection excludes a suspicion, check that its entry points, objects, configuration, and timing actually block the trigger. One safe entry point does not prove the others safe; once an adequate local protection blocks the failure mechanism, unrelated paths need not be enumerated. Insufficient exclusion evidence means keep investigating — it does not make the defect proven.

Judge severity only after the finding is proven. Potential impact does not lower the evidence bar, and every suspicion ends as proven, excluded, or explicitly limited. Merge the same root cause found by several focuses; when the fix requires changing a higher-level goal or decision, keep the concrete counterexample and hand it to whoever can decide.

## Check Coverage Before Output

Work back from the original goal and real mechanisms:

- Does every user outcome map to a unit, including necessary work the artifact did not list?
- Are there unchecked entry points, interface connections, or lifecycle paths affecting the same guarantee?
- Do the protections and connections the judgment relies on have evidence?

Add in-scope omissions to the existing list and finish them or note the limit; reuse evidence that is still valid. A narrow review checks only the delegated target and its necessary dependencies.

Then check the [delivery conditions](review-state.md#when-the-round-ends).
