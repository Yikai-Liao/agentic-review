# Report Rewrite Examples

These are rewrites of comments published in this project's own reviews, each against its reviewed version. They are not findings about the current change and do not re-judge the original defects. Sources and rationale are for maintenance and are never copied into published comments. Rewrites keep the original judgment, severity, and evidence strength; titles, indexes, alerts, and run metadata come from the caller, so findings show only `label`, `title`, and `body`.

## A failed close: state the premise that blocks retry first

Source: [PR #91 original comment](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421561733), reviewed version `7b4324beff99b656725f51f310b1d814d59ef26c`, later closed by a [fix note](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421622784).

The original used "sealed file", "sealed path", and "failure placeholder" for one object and began by explaining `try/catch/finally`, leaving readers to infer why a leftover file blocks retry. The rewrite first says the result file may not be overwritten, then walks through the failure:

- `label`: `P2`
- `title`: After closing the result file fails, the same review round cannot submit again

```markdown
**What goes wrong**: The submit tool creates a result file for the publisher and refuses to overwrite an existing one. If the content is written but closing the file throws, the tool reports failure yet leaves the file it created. A retry in the same round then fails again because the file exists (`EEXIST`).

**Why**: The cleanup branch only handles write failures. `sealed.close()` runs in `finally`, so its exception never reaches cleanup and the result file is not deleted. See [review-tools.ts:129–139](https://github.com/Qiyin-Tech/agentic-review/blob/7b4324beff99b656725f51f310b1d814d59ef26c/.github/pi-extensions/review-tools.ts#L129-L139) in the reviewed version.

**Fix and verify**: Make `.github/pi-extensions/review-tools.ts` also remove the result file created by this call when closing fails. Acceptance: simulating a successful write followed by a failed close returns failure and deletes the created file, and submission succeeds once the fault clears; on a normal submit, the workspace copy and the publisher's result file still match.
```

The original also claimed "if the fault leaves incomplete sealed content, the publisher cannot accept it". This example's premise is a successful write; file corruption needs other evidence and is not part of the proven problem. Dropping it does not assert the file can never be corrupted.

Restatement check: a failed close leaves the result file; the no-overwrite rule makes the retry fail. Missing either link is not a complete explanation.

## Concurrent submission: distinguish what the two copies are for

Source: [PR #91 original comment](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421493287), reviewed version `8ea95dfafc72b1ef1d6a924a63a0ef7ce4f67f9c`, later fixed.

- `label`: `P2`
- `title`: Concurrent submissions of different results can leave the kept copy different from what was published

```markdown
**What goes wrong**: When two submissions pass different review results concurrently, the publisher may use call A's conclusions while the workspace copy maintainers check later holds call B's.

**Why**: The submit tool saves the result twice: a workspace copy for maintainers and a result file for the publisher. The result file may not be overwritten, but the workspace copy is written before the race to create the result file. Both calls pass the "not yet submitted" check; after A writes its copy and creates the result file, B can still overwrite the copy before failing on the existing result file. See [review-tools.ts:128–129](https://github.com/Qiyin-Tech/agentic-review/blob/8ea95dfafc72b1ef1d6a924a63a0ef7ce4f67f9c/.github/pi-extensions/review-tools.ts#L128-L129) in the reviewed version.

**Fix and verify**: Make `.github/pi-extensions/review-tools.ts` let only the call that creates the result file write the workspace copy. Acceptance: with concurrent submissions of different content, the two files match exactly and a failed call cannot overwrite the successful call's copy.
```

The original already separated published content from the workspace copy; the rewrite keeps that boundary and delivers a concrete A/B ordering. "Workspace copy" and "the publisher's result file" must not share one name, or readers will think published content was overwritten.

## Credential tests: keep a misconfiguration apart from current production

Source: [PR #82 original comment](https://github.com/Qiyin-Tech/agentic-review/pull/82#discussion_r4420577606). Code evidence uses the version the comment explicitly names, `d3a10572b7b7dd1760f1b628378431956243ca01`, not later line numbers or commits from the comments API.

- `label`: `T1`
- `title`: A write-capable token passed through a configuration variable still passes the credential test

```markdown
**What goes wrong**: The central review agent must only ever read from GitHub; the trusted publisher writes after it finishes. If a repository or organization variable stores a write-capable token and the workflow passes it into the agent environment as `EXTRA_TOKEN: ${{ vars.REVIEW_WRITE_TOKEN }}`, the credential test still passes. Even with `GH_TOKEN` read-only, the agent could write to GitHub with the extra token.

**Why**: The source check `assertSafeSource` rejects only `secrets` and untraceable `steps` references and does not restrict `vars`; the other read-only token and job permission checks cannot see this extra path. See [review-runtime.test.ts:35–40](https://github.com/Qiyin-Tech/agentic-review/blob/d3a10572b7b7dd1760f1b628378431956243ca01/test/review-runtime.test.ts#L35-L40) in the reviewed version.

**Fix and verify**: Make `test/review-runtime.test.ts` detect and reject unapproved variable credential sources. Acceptance: the write-token configuration above makes the test fail; non-sensitive settings such as model names and service URLs, and the approved read-only GitHub token, still pass.
```

The necessary premise is that the extra token bypasses the read-only `GH_TOKEN`, not that any `vars` reference is dangerous. The rewrite keeps the condition that the variable actually holds a write token, and the difference between "the test misses it" and "production already leaks".

## Several branches or commits: scenario first, names second

Source: [PR #131 original comment](https://github.com/Qiyin-Tech/agentic-review/pull/131#discussion_r4467855797), reviewed version `777abb4bf7cfe9bf86488b943014985f3d60b4e8`, later fixed.

The original opened with X, Y, S, S^1, H, F and notations like `S:F` and `merge-base(S^1,H)`, so readers had to draw the commit graph before grasping the trigger. The rewrite tells the scenario with concrete objects and keeps the judgment, scope, and evidence:

- `label`: `P2`
- `title`: A source PR rebased after review lets unreviewed files from its branch count as reviewed

```markdown
**What goes wrong**: A source PR is reviewed against branch B, then rebased onto branch A and merged into A. The source branch now carries commits that exist on B but not A; a file changed only by those commits was never seen by the source review, yet the current PR records it as "reviewed in source PR" and never reviews it, even when it publishes a complete audit. Source PRs merged normally into their own target branch are unaffected.

**Why**: To decide whether the source PR reviewed a file, the current PR compares the merge result with the source head, and the pre-merge baseline with the merge-side fork point ([attribute-review-sources.ts:171](https://github.com/Qiyin-Tech/agentic-review/blob/777abb4bf7cfe9bf86488b943014985f3d60b4e8/scripts/attribute-review-sources.ts#L171)); both match for that file. But the source review actually started from the `merge-base` of its review-time baseline and the source head, and [find-review-checkpoint.ts:101](https://github.com/Qiyin-Tech/agentic-review/blob/777abb4bf7cfe9bf86488b943014985f3d60b4e8/scripts/find-review-checkpoint.ts#L101) does not read that baseline from the source review record (the Check externalId's third segment already stores it). The file is then marked complete in file progress ([review-coverage.ts:87](https://github.com/Qiyin-Tech/agentic-review/blob/777abb4bf7cfe9bf86488b943014985f3d60b4e8/scripts/review-coverage.ts#L87)).

**Fix and verify**: In `scripts/attribute-review-sources.ts`, use the baseline the source review actually used as the comparison start and require the file to be in that review's diff; when it cannot be confirmed, keep it pending or review it on top. Acceptance: a source PR reviewed on B, rebased and merged into A, with an extra commit touching only a B-history file, leaves that file pending; files the source PR itself changed, and source PRs merged normally into their baseline branch, still count as reviewed in source.
```

Branches get stable names such as "the source PR's review baseline B" and "the final merge branch A", and only `merge-base` survives as a necessary term; commit-graph detail gives way to the causality the reader must judge: which file, why it counts as reviewed, and the consequence.

## A status reason: one line on what invalidated the original trigger

Source: [PR #91 fix confirmation](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421622784), re-reviewed version `8af24fae785d9b1ba5fbd001899e9beb4138c761`.

The original reply said "fixed" first, then spent two paragraphs on the fix and new test. The status word and commit are added by the caller, so the reason alone is:

```text
A failed close now also deletes the result file this call created, so the same round can submit again (`review-tools.ts:131–140` in [8af24fa](https://github.com/Qiyin-Tech/agentic-review/commit/8af24fae785d9b1ba5fbd001899e9beb4138c761)); a new test covers retry after a failed close.
```

The caller renders it as the original finding's first line, `**✅ Resolved** (8af24fa): A failed close now also deletes…`. The summary lists only the title under resolved findings without repeating the reason.

## A re-review summary: behavior after merge describes the final state

Source: the [second-round summary](https://github.com/Qiyin-Tech/agentic-review/pull/131#pullrequestreview-5768904193) of [PR #131](https://github.com/Qiyin-Tech/agentic-review/pull/131), reviewing `777abb4` and then `ebc7af6`.

The original rewrote a ~550-character PR introduction, repeating almost the same long chain of "only files that … and … are marked …" conditions as round one, and stated the fix three times: in the opening, the introduction's last paragraph, and the finding list. The rewritten body:

```markdown
The rebase problem from the previous round is fixed; nothing needs handling.

### Behavior after merge

- PRs that sync branches no longer re-review files their source PRs already reviewed: a file whose content matches what the source PR reviewed counts as reviewed.
- Files produced by stacking or conflicts during the merge **are still reviewed**, labeled with the corresponding source PR.
- Files the source PR cannot be confirmed to have reviewed are reviewed normally.
- If source attribution fails, **the review stops** instead of marking files reviewed by mistake.

### Since last review

Whether a source PR reviewed a file is now judged against the baseline the source review actually used.
```

Decision conditions belong in code and findings; "Behavior after merge" holds only results the author can check. Fix details go in the finding's status reason, and the caller lists resolved findings. The original summary recorded no checked scenarios, so the rewrite does not invent "What was checked".

## A summary with no findings: say what happens after merge

Source: [PR #92](https://github.com/Qiyin-Tech/agentic-review/pull/92) and its [summary](https://github.com/Qiyin-Tech/agentic-review/pull/92#pullrequestreview-5709770630), reviewed version `d8844494b073dfcb94908200077e9a2d8233dd4a`.

```markdown
Nothing needs handling.

### Behavior after merge

Review startup now reads five groups of GitHub data concurrently instead of one at a time. Discussion refresh and linked-PR reads reuse the same implementation. The author's local timing of input preparation was 6.26–11.51 seconds before the change and **1.36–1.96 seconds after**.
```

One topic is one paragraph, one point per sentence. What was measured and by whom is stated in the sentence, with no review process, unexecuted items, or precautionary notes. The original summary also recorded no checked scenarios.

## Several topics: one item per topic

Source: [PR #99 summary](https://github.com/Qiyin-Tech/agentic-review/pull/99#pullrequestreview-5712050880), reviewed version `45b05da355fdbaae8a4013483ae3bd8a93a84710`.

The original put archiving, input preparation, and discussion refresh into one paragraph. The rewrite lists each change:

```markdown
Nothing needs handling.

### Behavior after merge

- **Archiving**: a successful publication report is uploaded with the completed workspace instead of being archived separately. The recoverable pre-publication draft and failure diagnostics paths are unchanged.
- **Input preparation**: patches for the same comparison range are generated once.
- **Discussion refresh**: returns the root comment, full replies, and current state of each changed discussion instead of scattered change records.
```

Each item covers one topic. With a single topic, keep a short paragraph rather than splitting it into a list for visual structure.
