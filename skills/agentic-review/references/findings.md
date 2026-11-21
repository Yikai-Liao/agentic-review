# Evidence Requirements for Findings

A reported problem is a **finding**. Record its kind, priority, and status separately: what the problem is, how urgent it is, and how far handling has progressed.

## What Every Finding Must Answer

- **Is it in scope?** A delta review shows how this change introduced, widened, or re-triggered it; an audit marks it as existing; a new proposal names what it is about to settle wrongly.
- **On what grounds?** The goal, constraint, or value being optimized has a source outside the artifact's own claims. Explicit decisions are checked for scope and preconditions.
- **Where exactly does it fail?** A checkable scenario and mechanism, and whose use, task, or decision is materially affected. A missing word, suspicious-looking code, majority opinion, or "might be better" is not enough.
- **What reasonable explanation could account for it?** The strongest protections, permitted implementation choices, existing decisions, and reasonable trade-offs were checked, and the problem still holds.
- **How do we know it is handled?** A root cause that can actually be changed, the requirement to restore or decision to obtain, and an acceptance endpoint that allows different implementations.

If any answer is missing, the suspicion stays in the workspace with its exclusion reason or evidence limit.

A review criterion from the request or project rules is grounds in itself. Breaking one the rule states as required ("must", "never") is a `defect`; departing from one it states as a preference ("prefer", "avoid") is an `improvement`, unless the rule says it blocks. Proof is the rule's text and scope, the location that departs from it, and a check of the exceptions the rule or a later explicit decision allows; no further consequence is needed.

## The Four Kinds

### Defect: `defect`

The artifact is proven to violate a grounded requirement. The evidence links the requirement, a trigger or ordering that can really occur, the current rule or mechanism, and the resulting wrong outcome and who is affected. Explicit contradictions in documents and static code reasoning can prove defects; record which form of proof was used. Undefined details stay unknown, and content that may legitimately wait follows the stage plan.

### Decision needed now: `decision`

A choice, authorization, or necessary fact that follow-on work already depends on is unresolved. State all of:

1. which planned decision or delivery depends on the answer;
2. how different answers change responsibility, compatibility, guarantees, cost, or execution path;
3. why existing material cannot resolve it, and why no one else is assigned to resolve it before the dependency;
4. the smallest question to answer, who may answer it, and the affected scope.

A missing retry count or metric on its own, or an unproven defect guess, stays in the investigation notes.

### Grounded improvement: `improvement`

No violation is proven, but a better approach is demonstrably worth considering, and this kind of optimization is in scope — explicitly requested or a default duty of the chosen level. Show the real task and evaluation goal, the cost of the current mechanism, a feasible alternative that keeps the necessary guarantees, and how the benefit compares with migration, new coupling, and learning costs. Some methods require stronger proof, such as showing no detection power is lost before deleting a test.

Improvements do not block delivery by default. A clear violation of an agreed goal is a defect; "the user wants it simpler" only authorizes investigating evidenced complexity cost.

### Insufficient verification now: `verification-gap`

A guarantee already needs verification evidence, but current verification cannot detect the relevant error. Requires all of:

1. a grounded verification requirement due at this stage, with verification adequacy in scope;
2. a local error drawn from a real mechanism or boundary;
3. analysis showing the error violates the guarantee yet escapes the relevant existing verification;
4. the smallest added observation that separates right from wrong while keeping adjacent legitimate behavior.

Low coverage, "more tests later", and general unknowns do not qualify. An acceptance check that accepts errors or rejects legitimate behavior can be a defect; a verification gap means discriminating evidence is still missing.

These four kinds serve every focus. A genuinely new way of holding true needs a maintainer to state its evidence and refutation and change this file; reviewers never add looser categories mid-review.

## Priority and Owner

Once a finding holds, judge priority by real impact, the delivery at hand, and urgency: blocks the relevant delivery or decision (name it), can proceed in isolation while fixed, or is scheduled independently. Levels may define display labels, which must rest on the proof.

Give each independently fixable root cause a stable round ID such as F1. If one change removes several symptoms, report one finding with all relevant acceptance checks; split only causes that need separate fixes. Report a production violation and the test that endorses it together. Link unchanged earlier problems to their original IDs.

Assign handling by the authority the fix needs:

- Solvable within existing requirements and authorization: the author of this level.
- Requires changing shared responsibility, interfaces, scope, important guarantees, or accepted costs: keep the counterexample and hand it to whoever can decide.
- A higher-level document itself conflicts with the original goal: show both sources; "approved" does not oblige the lower level to implement an error.

When the owner is unclear, state the open responsibility and evidence; never grant authority yourself. Accepting a business cost grants no run, release, or deploy permission.

## Output

Write each finding so it stands alone, following [Writing the report](reporting.md). The workspace keeps the full investigation, exclusion reasons, and the distinction between static reasoning, existing measurements, and unverified parts; public text expands only what the conclusion needs.

The location points to the smallest actionable root cause in the reviewed version: line ranges for code, clauses or the owner of an omitted responsibility for requirements and design. A delta review locates against the whole change from its base, never only the latest increment, and never invents diff lines.

Track problem status under the F IDs per [status evidence](review-state.md#evidence-for-status-changes). With no findings, say why the reviewed change matches its sources within the checked scope and keep the evidence limits.

Directly related earlier problems and decisions get a current status and a link in the workspace even without a new finding; public disclosure follows the caller's rules, and an object explicitly sent for re-review gets a direct answer. Unresolved stays unresolved, partial fixes name the remaining trigger, accepted items name the accepted scope, and a change that only touches an old problem is noted on the original entry. Cite stable IDs or recoverable sources.

A required output format changes the packaging, not the judgment. Run any required discussion or status refresh before submitting. When a needed rule body is missing or the output format is uncertain, recover it from the trusted source the task names; the reviewed artifact and earlier results never define the current interface. If the format cannot express an established conclusion, keep it in the workspace and report the interface limit; never drop it. End the round after a successful submission.
