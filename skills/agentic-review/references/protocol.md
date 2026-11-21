# Shared Investigation Protocol

All levels share these requirements; the chosen level and focuses supply the specific methods. Reuse existing evidence and add only what the current judgment still lacks.

## Fix the Target and Scope

Record the target and a version a later reader can recover: a commit for code; a revision, saved text, or content hash for documents. When the target changes, finish the old version or reinvestigate the affected parts; never combine evidence from two versions into one conclusion.

Distinguish two scopes:

- **Delta review**: problems introduced, widened, or re-triggered by this change, plus whatever a new proposal is about to settle. Say how each finding relates to the change.
- **Audit**: the current state of an explicitly named scope. It may report existing problems but must not claim this change introduced them.

Also pin down the decision or delivery at stake, the chosen level and focuses, original sources, permissions, output requirements, and available history.

## Establish What This Stage Must Satisfy

### Find sources independent of the artifact

Read the user's words, valid decisions, and real usage first, then interfaces, data agreements, and actual callers. Behavior the artifact must honor on independent grounds is a **contract**: call conditions, return values, retention rules, and so on. When reviewing requirements themselves, judge from the original request and real scenarios.

Existing code and system baselines describe the current state; author summaries help locate material. Code, tests, and comments written together share assumptions and cannot vouch for each other.

An explicit business decision can change the expectation; its validity follows the source rules given by the task. When sources conflict, quote both with their scope and the practical consequence of each reading. When history affects the expectation, attribution, or problem status, obtain the original records per [Related records and known issues](known-issues.md).

### Decide which requirements are due now

For each relevant requirement, find who needs what result under which conditions, who owns it, and the latest stage by which it must be settled. The key question: does the decision or delivery at hand already depend on the answer? For example, investigating an API's capability before choosing a design leaves the unknown with that investigation; running an irreversible migration before confirming the capability it relies on is a dependency gap.

Separate facts the source supports, inferences from them, and unknowns. For each gap, say what is missing and which choice it would change: investigate what reading can resolve, keep a concrete question for trade-offs the user must make, and leave alone what may legitimately wait. Metrics, priorities, attacker capabilities, and future requirements come from the sources, never from the reviewer.

## Investigate the Whole Delegated Scope and Its Connections

Split the scope into units that can be judged separately — a requirement, an interface, a state change, a group of related code — including additions, changes, deletions, relaxed constraints, and moved responsibilities. Work back from the goal to find work the author did not list. Units resting on the same mechanism and sources share reading and evidence.

Understand how the current design works before testing it with scenarios. For each unit you should be able to state:

1. what this stage requires and on what grounds;
2. which rule or mechanism satisfies it, or which necessary piece is missing;
3. which real scenario, input, ordering, change task, or acceptance result tests it;
4. who would observe what material impact;
5. which protections were checked, which choices were legitimately open, and what still lacks evidence.

Investigate new, changed, or relied-upon protections actively: after a retry is added, check that the relevant failure orderings keep the operation's semantics.

Risk ordering changes the investigation order, not the scope; done means every relevant unit has a conclusion. Mechanical changes note why no further analysis is needed. When material is truly unavailable, note what was checked, the gap that affects the judgment, and the next read or observation needed; the mechanism stays unknown. A serious problem outside a narrow scope may be flagged separately without changing the review's coverage.

## Verify Suspicions and Conclude

A suspicion is a possible problem not yet proven. Decide it with [Evidence requirements for findings](findings.md) plus the domain evidence of the chosen method. Locate the first rule, mechanism, or omission that fails and state the consequence; one gap yields one finding.

The **counter-evidence check** actively looks for what refutes the suspicion, starting with what is most likely to overturn it: upstream or downstream protection, real input limits, decisions assigned to a later stage, accepted costs, problems already present in the old version, and the cost of the alternative. A protection excludes a suspicion only when its entry points, objects, configuration, and timing actually block the trigger; one safe entry point does not prove the others safe, and once an adequate local protection blocks the mechanism, unrelated paths need not be enumerated. Keep each exclusion reason with the conditions it relies on so a recurring suspicion reuses it.

Every suspicion ends as proven, excluded, or explicitly limited; insufficient exclusion evidence means keep investigating, not that the defect is proven. Judge severity only after the finding is proven; potential impact never lowers the bar. When the fix requires changing a higher-level goal or decision, keep the concrete counterexample and hand it to whoever can decide.

## Check Coverage Before Output

Work back from the original goal and real mechanisms:

- Does every user outcome map to a unit, including necessary work the artifact did not list?
- Are there unchecked entry points, interface connections, or lifecycle paths affecting the same guarantee?
- Do the protections and connections the judgment relies on have evidence?

Add in-scope omissions to the list and finish them or note the limit; a narrow review checks only the delegated target and its necessary dependencies. Then check the [delivery conditions](review-state.md#when-the-round-ends).
