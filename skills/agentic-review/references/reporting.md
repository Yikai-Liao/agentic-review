# Writing the Report

These rules cover the summary, findings, status reasons for earlier findings, and replies to requests. A caller's fixed format changes the packaging, not these rules. Write in the report language the task selects; when the task supplies localized headings or labels, use them in place of the English ones below.

## Readers

The primary reader is the author of the change. Authors often write changes with AI help: they know what they want but may not know how the code actually does it, worry about hidden behavior or mismatches with their expectations, and often hand findings straight to their own coding agent. The second reader decides whether to accept the change. Neither saw the investigation, the call chains just read, or the reviewer's internal terms. From the report alone they should know what the system will do after the change; the change description is only background. Judge wording by the reader's cost of understanding: less guessing, looking things up, or piecing things together.

## Writing Rules

- Start from what the reader already knows: the expectation and its source (a behavior contract, the user's goal, a project rule, or the request), then what the artifact does instead, then why, then the checkable evidence. Pick the smallest scenario, input/output comparison, cost change, or code location that shows the difference.
- Use one stable name per object, keep different concepts distinct, and explain key identifiers in business terms on first use. Conditions, grounds, and causality are stated in place; links and code locations support verification, and the reader never has to open source to understand the claim.
- Follow the fixed sections below even for simple problems; a section may be one sentence. Each fact is expanded once; repeat only for navigation or emphasis. The full investigation stays in the workspace.
- Every claim has support in the material and keeps the original judgment's scope, severity, and strength; numbers, conditions, and sources are exact. When evidence is short, go back to investigating; never add a story to make the conclusion flow.
- Bound claims by the expectation, the places that depart from it, and what that costs whom; a complete account of these already bounds the impact. Give the behavior to restore or decision to obtain and the acceptance for the original trigger and related legitimate behavior, without presenting a suggested approach as the only implementation or expanding it into an implementation plan.
- Write only sentences that state an operation and trigger, a cause and consequence, a fix goal, or verifiable grounds. Excluded harms, "the risk is not worse", unexecuted verification, a review method the task already makes known (for example static-only review), execution logs, edit narration, self-assessment, and openings or closings that only restate stay out; "What was checked" in the summary is the one place for investigated scenarios.

## Summary

For a change review, write the summary in this order. The caller may add a title, a finding index, scope, and run information around it.

```markdown
[Verdict]

### Behavior after merge

- [behavior users can observe after the change lands]

### Since last review

[what the pushes since the previous review changed]

### What was checked

- [what was checked, against which expectation]: [conclusion and its grounds] (`path:line`)
```

Use these level-three headings, never bold paragraphs or level-one/two headings, and omit sections with nothing to say. One point per sentence: a reader scanning it should see how many points there are, so never join points with semicolons or squeeze a list into a paragraph.

**Bold** the few words the reader must act on or check: which problem to handle first, the key result of a behavior change, a change the description does not mention. At most one per item, never a whole sentence. Use *italics* to quote the change description against the current implementation.

**Verdict**: the opening paragraph tells the reader what to do next and what to handle first, without problem details, for example "A wrong price would pass the tests; **add the assertion before merging**." Problems to handle include new findings and still-unresolved earlier ones, counted the same way as any title. Say there is nothing to handle only when neither exists; when only earlier problems remain, say which. Improvements never block: when they are the only findings, say nothing blocks and that optional improvements follow. A partial review states its actual scope here.

**Behavior after merge** lets an author who did not hand-write the code check what the system does after merge against their expectation:

- Describe the final state from base (the target branch before merge) to the current head, compared only with base, for example "before this change, this case stopped the review from starting". Earlier iterations of the change never appear.
- Rewrite it each round from the current full diff; keep a previous round's sentence only if code in the current diff supports it.
- Write in observable terms: which operation or input, and how the system now responds.
- End items that change existing behavior without mention in the description, linked issues, or commit messages with "**(not mentioned in the description)**". Defaults, failure handling (continue, skip, return a default), permissions, data writes, configuration, dependencies, and CI are existing behavior; refactors with no external effect are not.
- When the description contradicts the implementation, add "The description says *X*; the implementation does Y."
- One topic is a paragraph; several topics are a list with one topic per item.

**Since last review**: only on re-review, saying what the pushes after the previous review changed; when the direction changed, start with "Approach changed: …". Removing this section must leave "Behavior after merge" fully valid.

**What was checked** lets an author wary of AI-written code verify what the review actually checked:

- Each level, focus, criterion, or emphasis the request or project rules added beyond the default gets at least one item, so the reader can see it was applied and challenge the judgment. When it produced no finding, the item names the closest case examined, with location, and why it meets the expectation or stays below the finding bar; when the change gives it nothing to judge, say what the change lacks. "Checked, no problems" without a case is not an item. Its findings stay in the findings.
- Then pick from the workspace the checks where this change is most likely to go wrong, preferring where relevant: failures swallowed or silently degraded; tests deleted, relaxed, or mocked to always pass; changes beyond the stated topic; hard-coded values or unfinished placeholders; changed behavior for existing callers; permission and data boundaries.
- One check per item, with the conclusion, its grounds, and a code location, confirmed along the code this round.
- With no new findings this section is the body of the summary: 3–5 items. With new findings, at most 3 besides the added-focus items.
- On re-review include only checks related to this round's changes; omit the section when nothing substantive changed (for example only the target branch was merged in).

Requests that ask a specific question get the verdict first, then an answer organized around the request, using these sections where useful.

## Findings

Each finding stands alone; the author may hand it whole to a coding agent, so it must be readable and actionable without the summary.

**Title**: one line stating trigger and consequence, for example "Recording an unknown price as 0 still passes the 'unknown price' test". It may appear alone in an index; the body does not repeat it.

**Body** for defects, test problems, and verification gaps, whatever expectation they break — three sections, each opening with a short bold label:

```markdown
**What goes wrong**: [what is expected and from which source, what the artifact does instead, and who bears what consequence or cost.]

**Why**: [the mechanism or decision that causes it and why existing protection or rules fall short; code or contract location.]

**Fix and verify**: [the constraint to restore; file path, expected behavior, and an acceptance scenario that proves the fix.]
```

Confirmations and decisions say who must decide what:

```markdown
**Actual behavior**: [what the code does now, with location.]

**Difference from expectation**: [what the description, an issue, or an existing decision says, or which necessary decision is missing.]

**Impact**: [what merging with the current behavior causes.]

**Decision needed**: [the question and possible directions; after the author replies, the next round closes it or turns it into a finding.]
```

Improvements use **Current state** (what the artifact does and what it costs against the stated goal or preference) and **Suggestion** (the alternative, what it gains, and how to check it).

Rules:

- The first section starts from something the author can check without first trusting the reviewer: observable behavior, or the stated rule or goal and the place that departs from it.
- "Fix and verify" works when copied out alone: full paths, expected behavior, and acceptance method, with no "above" or "there". Write acceptance as the result that should be observed, not as already executed.
- Fits on one screen. Title and body agree on object, condition, and severity.
- Put versions and locations next to their grounds. With a real URL use a full Markdown link labeled with the file name or short SHA and bound to the reviewed version; otherwise keep the exact version and path as plain text. When a specific expression is the root cause, put a minimal fenced code block with a language tag in "Why".
- Performance findings give scale, the base and head cost functions, and order-of-magnitude or complexity evidence in "Why".
- Test findings give their branch proof in "Why": the violating probe for T1, the allowed-change probe for a T2 change detector, or the deletion test, base or sibling coverage, and missing unique witness for T2 redundancy.
- Anchor to one line when it expresses the root cause; cover a range only when declaration, condition, call, or error handling together form it.

The bar, priority, and root-cause merging come from [finding requirements](findings.md) and the chosen level.

## Status Reasons for Earlier Findings

A status reason is one line stating the reason itself; the caller adds the status word, commit, and title. Write by outcome:

- Fixed: what makes the original trigger no longer occur, with location, for example "the new assertion checks the price state the extension saves (`test/review-cost.test.ts:120`)".
- Refuted: the fact that overturns the original judgment, with location.
- Accepted: who accepted what scope in which reply, with a link.
- Severity increased or reintroduced: the new trigger and consequence.

Locations use real sources; match link labels to the target type and never pass a commit link off as a file link. Progress that does not change status stays in the workspace. A new root cause introduced by a fix is a new finding that links the original discussion.

A reply to a request answers the request and the reason the judgment changed or held, without repeating the whole original finding.

## Final Self-Check

Reread the actual output using only the report and the change description. Each answer must point to text in the report; a missing answer is "not stated" and is never filled in from memory of the investigation:

- Which expectation is not met, and where does it come from?
- Where, and under which condition, does the artifact depart from it?
- Who bears what consequence or cost, and how widely?
- What must change or be decided, and how is that checked?

Fix wording or evidence for any finding missing a key answer. Then check the summary: it starts with the verdict and uses only the sections above; every "Behavior after merge" item maps to code in the current base..head diff; removing "Since last review" leaves the rest valid; every "What was checked" item has a check, conclusion, and location; finding details appear only in findings and status reasons only in status updates. Finally apply the last writing rule sentence by sentence and check that status reasons say what invalidated or revived the original trigger.

When necessary premises are missing, objects get confused, or causality is hard to organize, see the [rewrite examples](report-examples.md); their facts never bear on the current review.
