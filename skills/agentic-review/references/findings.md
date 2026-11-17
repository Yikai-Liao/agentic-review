# Evidence Requirements for Findings

A reported problem is a **finding**. Record its kind, priority, and status separately: what the problem is, how urgent it is, and how far handling has progressed. The four kinds and their bars follow.

## What Every Finding Must Answer

- **Is it in scope?** A delta review shows how this change introduced, widened, or re-triggered it; an audit marks it as existing; a new proposal names what it is about to settle wrongly.
- **On what grounds?** The goal, constraint, or value being optimized has a source outside the artifact's own claims. Explicit decisions are checked for scope and preconditions.
- **Where exactly does it fail?** Give a checkable scenario and mechanism and say whose use, task, or decision is materially affected. A missing word, suspicious-looking code, majority opinion, or "might be better" is not enough.
- **What reasonable explanation could account for it?** Check the strongest protections, permitted implementation choices, existing decisions, and reasonable trade-offs, and say why the problem still holds.
- **How do we know it is handled?** Point to a root cause that can actually be changed, state the requirement to restore or decision to obtain, and give an acceptance endpoint that allows different implementations.

If any answer is missing, keep the exclusion reason or evidence limit and leave the suspicion in the workspace.

## The Four Kinds

### Defect: `defect`

The artifact is proven to violate a grounded requirement. The evidence links the requirement, a trigger or ordering that can really occur, the current rule or mechanism, and the resulting wrong outcome and who is affected.

Explicit contradictions in documents and static code reasoning can prove defects; record which form of proof was used. Undefined details stay unknown; content that may legitimately wait follows the stage plan; "defect" is reserved for proven violations.

### Decision needed now: `decision`

A choice, authorization, or necessary fact that follow-on work already depends on is unresolved. State all of:

1. which planned decision or delivery depends on the answer;
2. how different answers change responsibility, compatibility, guarantees, cost, or execution path;
3. why existing material cannot resolve it, and why no one else is legitimately assigned to resolve it before the dependency;
4. the smallest question to answer, who may answer it, and the affected scope.

A missing retry count or metric on its own, or an unproven defect guess, stays in the investigation notes.

### Grounded improvement: `improvement`

No violation is proven, but a better approach is demonstrably worth considering, and this kind of optimization is in scope — explicitly requested or a default duty of the chosen level.

Show the real task and evaluation goal, the cost of the current mechanism, a feasible alternative that keeps the necessary guarantees, and how the benefit compares with migration, new coupling, and learning costs. Some methods require stronger proof, such as showing no independent detection power is lost before deleting a test.

Improvements do not block delivery by default. A clear violation of an agreed goal is proven as a defect; "the user wants it simpler" only authorizes investigating evidenced complexity cost.

### Insufficient verification now: `verification-gap`

A guarantee already needs verification evidence, but current verification cannot detect the relevant error. Requires all of:

1. a grounded verification requirement due at this stage;
2. a local error drawn from a real mechanism or boundary;
3. analysis showing the error violates the guarantee yet escapes the relevant existing verification;
4. the smallest added observation that separates right from wrong while keeping adjacent legitimate behavior.

Verification adequacy must also be in scope. Low coverage, "more tests later", and general unknowns do not qualify.

An acceptance check that accepts errors or rejects legitimate behavior can be a defect; a verification gap means discriminating evidence is still missing. The chosen method gives the specific proof; do not report one root cause twice.

The four kinds serve every focus; do not invent a new kind per focus. If a new way of holding true genuinely cannot be expressed, a maintainer first states what evidence it needs and what refutes it, then changes this file; reviewers never add looser categories mid-review.

## Priority and Owner

Once a finding holds, judge priority by real impact, the delivery at hand, and urgency: blocks the relevant delivery or decision, can proceed in isolation while fixed, or is scheduled independently. When saying "blocks", name the delivery or decision that depends on it; the scope may be narrower than the whole project. Levels such as code may define display labels, which must rest on the proof.

Give each independently fixable root cause a stable ID for the round, such as F1. If one change removes several symptoms, report one finding with all relevant acceptance checks; split only causes that need separate fixes. Report a production violation and the test that endorses it together. Link unchanged earlier problems to their original IDs.

Assign handling by the authority the fix needs:

- Solvable within existing requirements and authorization: the author of this level.
- Requires changing shared responsibility, interfaces, scope, important guarantees, or accepted costs: keep the counterexample and hand it to whoever can decide.
- A higher-level document itself conflicts with the original goal: show both sources; "approved" does not oblige the lower level to implement an error.

When the owner is unclear, state the open responsibility and evidence; never grant authority yourself. Accepting a business cost grants no run, release, or deploy permission.

## Output

Lead with a one-sentence conclusion and put key scope limits right next to it; then list the problems to handle. Write each finding so it stands alone, following [Writing the report](reporting.md).

Keep static reasoning, existing measurements, and unverified parts distinct in the workspace, along with the full investigation and exclusion reasons. Public text expands only the conditions and evidence needed to understand the conclusion; the caller's format governs disclosure. When facts are missing, say what material is needed; when a trade-off is needed, state the options and costs.

The location points to the smallest actionable root cause in the reviewed version: line ranges for code, clauses or the owner of an omitted responsibility for requirements and design. Never invent diff lines.

Track problem status in the workspace under the F IDs and update it per [status evidence](review-state.md#evidence-for-status-changes). Code-level P labels express proven impact and may convey priority; T labels describe how a test fails. Kind and status are still recorded separately.

With no findings, say why the reviewed change or requirement matches its sources within the checked scope, and keep the evidence limits. Omit empty sections and limit conclusions to the checked scope; merge approval belongs to the relevant authority.

Directly related earlier problems or decisions get a current status and a link in the workspace even without a new finding. Public disclosure follows the caller's rules for this change; an object explicitly sent for re-review gets a direct answer. Unresolved stays unresolved; partial fixes name the remaining trigger; accepted items name the accepted scope; fix status follows fix evidence. A change that only touches an old problem is noted on the original entry. Limit history to what is related and cite stable IDs or recoverable sources.

A required output format changes the packaging, not the judgment. If a discussion or status refresh is required before submission, do it first. When a needed rule body is missing or the output format is uncertain, recover it from the trusted source named by the task; never infer the current interface from the reviewed artifact or earlier results.

If the fixed format cannot express an established conclusion, keep the workspace and report the interface limit explicitly. Use only authorized interfaces and labels and never drop an established conclusion. End the round after a successful submission.
