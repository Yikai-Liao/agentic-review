# Writing the Report

These rules cover the summary, findings, status reasons for earlier findings, and replies to requests. A caller's fixed format changes the packaging, not these rules. Write in the report language the task selects; when the task supplies localized headings or labels, use them in place of the English ones below.

## Readers

The primary reader is the author of the change. Authors often write changes with AI help: they know what they want but may not know how the code actually does it, worry about hidden behavior or mismatches with their expectations, and often hand findings straight to their own coding agent. The second reader decides whether to accept the change. Neither saw the investigation, the call chains just read, or the reviewer's internal terms. From the report alone they should know what the system will do after the change; the change description is only background. Judge wording by the reader's cost of understanding: less guessing, looking things up, or piecing things together.

## Writing Rules

- Start from an operation or scenario the reader knows, and add the project rules from the material that the conclusion needs, so action, cause, and result connect. Titles and first paragraphs say what happens; then explain why the current mechanism causes it; then give checkable evidence. Pick the smallest failure scenario, state change, input/output comparison, or cost change that shows the problem.
- Use one stable name per object and explain key identifiers on first use; keep different concepts distinct. Necessary conditions, grounds, and causality are available in place; links and code locations support verification, and the reader never has to open source or assemble internal terms to understand the claim.
- Follow the fixed sections below even for simple problems; a section may be one sentence. Every paragraph adds information and each fact is expanded once; keep repetition only for navigation, explanation, or emphasis. Length, short sentences, or section count do not stand in for readability. The full investigation stays in the workspace.
- State results, conditions, and concrete gaps directly. Mention only conditions that affect the judgment or the action; give the behavior to restore or decision to obtain, plus the acceptance needed for the original trigger and related legitimate behavior. Do not present a suggested approach as the only implementation or expand it into a small implementation plan.
- Every claim has support in the material and keeps the original judgment's task, scope, severity, and strength; numbers, conditions, and sources are exact. Material supports the judgment and is not retold item by item. When evidence is short, go back to investigating; never add a story to make the conclusion flow.
- Bound claims by the affected object, trigger, and concrete consequence. A test finding names which wrong input the test accepts and which assertion misses it. A complete account of these facts already bounds the impact; do not add that something worse did not happen. Excluded harms, assumptions outside the judgment, execution logs, and investigation steps stay in the workspace, except for the "What was checked" section of the summary.
- When the review method is a known premise of the task (for example static-only review), public text does not restate it or list tests, fault injection, or re-runs that were not executed. Remove edit narration, writing strategy, self-assessment, precautionary clarifications without a concrete question, and openings or closings that only restate.

## Summary

For a change review, write the summary in this order. The caller may add a title, a finding index, scope, and run information around it.

```markdown
[Verdict]

### Behavior after merge

- [behavior users can observe after the change lands]

### Since last review

[what the pushes since the previous review changed]

### What was checked

- [concrete scenario]: [conclusion and the mechanism that blocks it] (`path:line`)
```

Use these level-three headings rather than bold paragraphs, and add no level-one or level-two headings.

Write as many sentences as needed, one point per sentence. Do not join several points with semicolons or squeeze a list into a paragraph; a reader scanning it should see how many points there are.

**Bold** the few words the reader must act on or check: which problem to handle first, the key result of a behavior change, a change the description does not mention. At most one per item; bolding a whole sentence or paragraph is no emphasis. Use *italics* to quote the change description against the current implementation.

**Verdict**: the opening paragraph tells the reader what to do next and what to handle first, without problem details, for example "A wrong price would pass the tests; **add the assertion before merging**." Problems to handle include new findings and still-unresolved earlier ones, counted the same way as any title; say there is nothing to handle only when neither exists, and when only earlier problems remain, say which.

**Behavior after merge**: lets an author who did not hand-write the code check whether "what the system does after merge" matches their expectation.

- Describe the final state from base (the target branch before merge) to the current head. Compare only with base, for example "before this change, this case stopped the review from starting"; earlier iterations of the change never appear.
- Rewrite it each round from the current full diff. A previous round's description is only a draft; keep a sentence only if code in the current diff supports it.
- Write in observable terms: which operation or input, and how the system now responds. Explain what key identifiers mean in business terms on first use.
- End items that change existing behavior without mention in the description, linked issues, or commit messages with "**(not mentioned in the description)**". Defaults, failure handling (continue, skip, return a default), permissions, data writes, configuration, dependencies, and CI are existing behavior; refactors with no external effect are not.
- When the description contradicts the implementation, add "The description says *X*; the implementation does Y."
- One topic is a paragraph; several topics are a list with one topic per item, as many as actually exist.

**Since last review**: only on re-review. Say what the pushes after the previous review changed; when the direction changed, start with "Approach changed: …". Removing this section must leave "Behavior after merge" fully valid.

**What was checked**: lets an author wary of AI-written code verify item by item what the review actually checked.

- From the scenarios in the workspace, pick where this change is most likely to go wrong. Prefer, where relevant: failures swallowed or silently degraded; tests deleted, relaxed, or mocked to always pass; changes beyond the stated topic; hard-coded values or unfinished placeholders; changed behavior for existing callers; permission and data boundaries.
- One scenario per item, with the conclusion, the blocking mechanism, and a code location. Include only scenarios confirmed along the code this round, as many as there are.
- With no new findings this section is the body of the summary: 3–5 items. With new findings, at most 3.
- On re-review include only scenarios related to this round's changes; omit the section when nothing substantive changed (for example only the target branch was merged in).

Requests that ask a specific question get the verdict first, then an answer organized around the request, using these sections where useful. A partial review states its actual scope in the verdict.

**Done when**:

1. the summary starts with the verdict and contains only the sections above, as level-three headings;
2. every item in "Behavior after merge" maps to code in the current base..head diff and never uses an earlier iteration as reference;
3. removing "Since last review" leaves the rest valid;
4. every item in "What was checked" has a concrete scenario, conclusion, and code location;
5. finding details appear only in the finding, and status reasons only in the status update;
6. no sentence joins several points with semicolons, and bold falls only on words the reader must act on or check.

## Findings

Each finding stands alone; the author may hand it whole to a coding agent, so it must be readable and actionable without the summary.

**Title**: one line stating trigger and consequence, for example "Recording an unknown price as 0 still passes the 'unknown price' test". It may appear on its own in an index, so it must stand alone; the body does not repeat it.

**Body** for defects, test problems, and verification gaps — three sections, each opening with a short bold label:

```markdown
**What goes wrong**: [the concrete operation or input, expected versus actual, and who sees what consequence.]

**Why**: [the mechanism that causes it and why existing protection falls short; code or contract location.]

**Fix and verify**: [the constraint to restore; file path, expected behavior, and an acceptance scenario that proves the fix.]
```

Confirmations and decisions say who must decide what:

```markdown
**Actual behavior**: [what the code does now, with location.]

**Difference from expectation**: [what the description, an issue, or an existing decision says, or which necessary decision is missing.]

**Impact**: [what merging with the current behavior causes.]

**Decision needed**: [the question and possible directions; after the author replies, the next round closes it or turns it into a finding.]
```

Improvements use **Current state** and **Suggestion**.

Rules:

- The first section starts from what a user can observe, so the author can replay it mentally without first trusting the reviewer.
- "Fix and verify" works when copied out alone: full paths, expected behavior, and acceptance method, with no "above" or "there". Write acceptance as the result that should be observed, not as already executed, and do not present the suggested approach as the only implementation.
- Fits on one screen. Other risks excluded while grading and the investigation stay in the workspace. Keep sentences that state trigger, cause, proven consequence, grounds, or fix goal; delete sentences that only say some extra harm did not occur, the risk is not worse, or some verification did not run. Title and body agree on object, condition, and severity.
- Explain the business meaning of key identifiers on first use. Put versions and locations next to their grounds; with a real URL use a full Markdown link labeled with the file name or short SHA and bound to the reviewed version; without one, keep the exact version and path as plain text. When a specific expression is the root cause, put a minimal fenced code block with a language tag in "Why".
- Performance findings give scale, the base and head cost functions, and order-of-magnitude or complexity evidence in "Why".
- Test findings give their branch proof in "Why": the violating probe for T1, the allowed-change probe for a T2 change detector, or the deletion test, base or sibling coverage, and missing unique witness for T2 redundancy.
- Anchor to one line when it expresses the root cause; cover a range only when declaration, condition, call, or error handling together form it.

The bar, priority, and root-cause merging come from [finding requirements](findings.md) and the chosen level; this section only covers expression.

## Status Reasons for Earlier Findings

A status reason is one line stating the reason itself; the caller adds the status word, commit, and title. Write by outcome:

- Fixed: what makes the original trigger no longer occur, with location, for example "the new assertion checks the price state the extension saves (`test/review-cost.test.ts:120`)".
- Refuted: the fact that overturns the original judgment, with location.
- Accepted: who accepted what scope in which reply, with a link.
- Severity increased or reintroduced: the new trigger and consequence.

Locations use real sources; keep link targets as is, match labels to target type, and never pass a commit link off as a file link. Progress that does not change status stays in the workspace. A new root cause introduced by a fix is a new finding that links the original discussion.

A reply to a request answers the request and the reason the judgment changed or held; it need not repeat the whole original finding.

## Final Self-Check

Before submitting, reread the actual output using only the report and the change description. Each answer must point to text in the report; a missing answer is "not stated" and is never filled in from memory of the investigation:

- Which operation fails under which condition?
- Who sees what consequence, and how widely?
- Why does the current mechanism cause it?
- What behavior must be restored or decision obtained?

If a finding lacks a key answer, fix the wording or evidence before submitting. Check the summary against its done conditions; check that status reasons say what invalidated or revived the original trigger. Then check sentence by sentence: does it state an operation and trigger, a cause and consequence, a fix goal, or verifiable grounds? Delete sentences that only deny extra risk, restate the default review method, or repeat earlier text, except "What was checked" items with scenarios and grounds. Express needed scope through the objects and conditions above. Check attribution and evidence strength, and keep concrete open factual gaps. A reader understands every claim without opening source; code locations are for verification.

When necessary premises are missing, objects get confused, or causality is hard to organize, see the [rewrite examples](report-examples.md); their facts never bear on the current review.
