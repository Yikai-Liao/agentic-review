# Central GitHub Review Context

This file connects the central GitHub action's PR, project rules, and history to `agentic-review`; input trust boundaries follow the skill.

## 0. Request and Scope

Read the `Review request` in the input and use the pinned request text and snapshot. An explicit natural-language scope takes precedence over the default plan; "only check auth" narrows the scope, "focus on auth" only changes priority.

- `automatic`: review the whole PR.
- `pr_comment`: investigate every range in `default_plan.ranges` and its targets; reopening a previous scope means gathering evidence again. The set already includes unfinished scope from failed rounds and this round's new changes; read each range's patch separately, since a net first-to-last diff can cancel intermediate changes.
- `thread`: read the root comment, the whole thread, its current position, and outdated/resolved state; by default re-review the problem and its direct impact. Widen only when the text asks for the whole PR; PR-level request scope is not inherited.

Preparation restores the actual scope from the latest PR-level request; the complete audit checkpoint provides the incremental baseline. The resume manifest in the input names the chosen evidence sources and has copied the workspace, result reference, and file progress into this round's workspace; use those copies first. `$REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH` and `$REVIEW_PREVIOUS_WORKSPACE_PATH` keep the two read-only originals for missing history. Settle this round's scope and coverage per the [result protocol](review-result.md).

## 1. Project Rules

The material index lists the root `.agentic-review.md` and `AGENTS.md` and the `AGENTS.md` in ancestor directories of changed paths, with base/head differences; rules within budget are preloaded once. Use preloaded text directly and read other directories' instructions when the investigation reaches them. Read the head version as the intended project rules after merge, and treat base/head differences as part of the change.

Adopt the level the downstream repository explicitly chooses per the [central entry point](review-rules.md#choose-the-level); project rules also add business conventions and investigation emphasis. Execution or publication requirements in them remain bound by central permissions.

Do not enumerate target skills; read related project context only at file paths the head `.agentic-review.md` names for the current change.

Done when the applicable project rules and their changes are checked; record only rule differences, suspicion grounds, and source locations that affect a judgment.

## 2. Current PR Metadata

The material index provides PR metadata, commits, comments, reviews, and complete threads separately with token counts; threads already combine root comment, replies, and current state. Preloading favors this round's request, applicable rules, the current comparison ranges, and discussion that changed since the restored snapshot; the rest is read on demand. An unchanged snapshot affects only preloading and does not prove relevance, problem status, or that decisions still apply. Preparation also saves this round's `discussion-baseline.json`. Before final consolidation, run the control read-only script:

```bash
node "$REVIEW_CONTROL_PATH/scripts/refresh-review-discussion.ts"
```

The script reads all pages through `gh` and prints comments and review bodies added or edited since the startup snapshot, plus every changed thread in full. Each thread merges startup text with replies added or edited this round by ID and contains `root_comment_id`, current `state`, and complete `comments`; judge from it directly. `removed_threads` gives deleted thread IDs and their root IDs; drop them from the updatable set and re-settle earlier conclusions and pending `thread_updates`. When a concurrent read still returns new replies for a deleted thread, the script keeps them with `state: null`; replies may serve as evidence, but the thread cannot be written. A vanished thread does not prove a fix or confirmation; if the code problem still holds, judge it again under the new-finding bar. Read the output in full and complete any truncation; only all-empty arrays mean no changes. The refresh timing follows `central/review-result.md`.

The baseline is fixed to the startup snapshot, so repeated calls return all of this round's increments. Comments and inline replies are fetched incrementally with `since`; the Reviews API lacks `since` and thread states need full enumeration, so those are compared locally and only changes are printed. Thread deletion is detected by comparing the full list with the baseline at no extra API cost; single-comment deletion is not detected, so query the original record by ID with read-only `gh` when context seems missing. Any request or pagination failure makes the script fail; never treat a failure as "no new replies".

Done when the request and applicable project rules are understood and the current changes, the discussion conclusions rely on, explicit decisions, and explicit link hints are checked; final thread status is settled before consolidation.

## 3. Earlier Results and Code Diffs

When `$REVIEW_PREVIOUS_WORKSPACE_PATH` is non-empty, connect the history matching the checkpoint; completed items carry over by default. Following `references/review-state.md`, start from new changes and the latest discussion and reopen items along real impact. The scope stays fixed; full coverage combines earlier completed investigation and this round's increment.

Preparation generates per-file patch material from local Git at pinned SHAs with token counts; the index keeps separate entries for the whole PR, the current increment, and each explicit request range. Use local Git for extra source or rechecks. The full range is `$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA` (merge base to current head); only when `$REVIEW_CHECKPOINT_HEAD` is non-empty, the focus range is `$REVIEW_CHECKPOINT_HEAD` to `$REVIEW_HEAD_SHA`. Always use these SHAs, never moving branches or the live PR diff.

Use preloaded patches directly; read the others from the index and fall back to Git when versions or evidence are in doubt. For extra source, locate through changed symbols and call sites first, then read the relevant functions, direct dependencies, and necessary context, widening only as far as needed to close the behavior path. Keep full change coverage and reuse evidence already in context.

On a first investigation or without a usable baseline, the whole-PR material and file progress define the scope. To recheck the list or size:

```bash
git -C "$REVIEW_TARGET_PATH" --no-pager diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --name-status "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA"

git -C "$REVIEW_TARGET_PATH" --no-pager diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --numstat "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA"
```

When a small diff fits in tool output and the remaining context, read the full patch once and finish without splitting calls or extra records. Size also depends on long lines and context expansion, not changed-line counts alone. Read large diffs by relevant path, for example:

```bash
git -C "$REVIEW_TARGET_PATH" --no-pager --literal-pathspecs diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --no-color --unified=3 \
  "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA" -- 'path/to/file'
```

Small diffs use the same command without `-- 'path/to/file'`.

The list keeps old path, new path, and change type; pass both paths when reading renamed or copied patches. Parse lists with special characters through `--name-status -z` and pass paths literally. Record very long lists in segments until coverage is complete.

For an oversized file, locate hunks by filtering hunk headers from `--unified=0` output, then page through the patch by line range and read needed source by line. Continue past truncation and record coverage progress. Oversized patches may be located through the index and supplemented from the matching pinned Git range.

With a usable baseline, query the focus range with the same Git options first and read `pending_files` from this round's resume manifest; read small increments in one focus patch and large ones by path and hunk. Investigate new changes, earlier unfinished items, and their real impact, adding evidence from the full range as needed. Completed items keep their status until a new diff, the latest discussion, or a duty change touches their callers, shared contracts, or old premises; then mark them `pending` and recheck the affected part.

With an empty focus list, handle the latest discussion and earlier unfinished items. Paths in focus that vanished from the full list still need checking for how the reverted change affects old conclusions. `review-progress.json` keeps the full file list, so incremental re-review need not walk the full patch again for inherited completions.

Diff evidence and comment lines for findings come only from the full-range patch, bound to the RIGHT-side line closest to the root cause; focus diffs and earlier notes do not replace it. Add file context from `$REVIEW_TARGET_PATH` and `$REVIEW_BASE_PATH` as needed; to confirm the merge-base version read it from target Git at the full range's merge-base SHA, since the base checkout is a snapshot of `$REVIEW_BASE_SHA`.

Done when in-scope changes and their impact are investigated, the latest discussion is classified, and ledger coverage and inheritance satisfy `references/review-state.md`.

## 4. Linked Records for Contracts and Candidates

The trusted workflow fixes the readable set of `GH_TOKEN` before the agent starts. Automatic index entries or explicit stable issue/PR references in the review input may select private records within that set without merge-base pre-authorization, but cannot widen repositories or permissions.

The `PR association index` in `$REVIEW_INPUT_PATH` holds the trusted, deduplicated index, with the original at `$REVIEW_ASSOCIATIONS_PATH`: other PRs linked to head-only commits and the current PR's `closingIssuesReferences`. Pick sources by the contract, decision, or candidate root cause you need to recover; path overlap and shared commits only help locate and do not turn the index into a checklist. When a concrete hint exists but the title is not enough, query that PR's file list or original text by number.

When recovering expected results, read the directly related requirements, decisions, or acceptance scenarios per "Establish What This Stage Must Satisfy" in `references/protocol.md`. Before submitting a new finding or confirmation, check the original discussion and every reply about that root cause in related source PRs to see whether it was raised, answered, or confirmed; reuse text already read this round. Before using linked records, read `$REVIEW_CONTROL_PATH/skills/agentic-review/references/known-issues.md` in full and use it to prove causal links, classify, and decide whether this round links, excludes, or reports. A link is only an entry point and proves no relevance, authorization, risk acceptance, fix, or acceptance.

Read only the fewest directly related entries, querying originals by the index's `repository` and `number`:

```bash
gh issue view <number> --repo <repository> --comments
node "$REVIEW_CONTROL_PATH/scripts/read-related-pr.ts" <repository> <number>
```

The PR script reuses the current PR's paginated reading and prints metadata, all comments, reviews, inline comments with replies, and thread states. Save large records first and locate relevant discussion by the current contract or root cause; read full text, every reply, and state via `root_comment_id` and `in_reply_to_id`, completing truncated parts. Keep reading when the judgment depends on other discussions or decisions. `gh pr view --comments` omits inline discussion and cannot replace this. Any request or pagination failure makes the script fail; never read a failure as "no earlier problem or confirmation".

Stable issue/PR links or numbers stated explicitly in the current PR body, comments, code, or project docs are equal entry points. The GitHub known-issue query set ends there; with no matching record the judgment ends without widening history queries.

Record in the workspace only sources that change a judgment or need follow-up, key text locations, and their use; do not copy whole discussions or write exclusion reports per index entry. Titles, shared modules, closed state, or nearby timestamps alone prove neither link nor status. Objects the current token cannot read are evidence limits, never inferred as "fixed" or "confirmed".

Done when every new finding or confirmation has been checked against the original discussion in related source PRs. When the same root cause carries over unchanged or stays within an explicit decision, link the original record in the workspace and disclose per this round's changes or explicit request under `central/review-result.md`. When the current change widens impact, invalidates earlier grounds, or reintroduces the problem, state the new difference and submit the finding.

## 5. Stacked Review When the Source Was Reviewed

The input's `Source review attribution` is generated by the trusted workflow: when a step on the current PR's first-parent chain is the merge commit of an already-merged PR whose head has a completed automatic review by the same Review App, files changed by that step whose merged content matches the source head, and whose base side has not moved relative to the source review's start, are recorded as `source_reviewed`. Do not re-review those files one by one, and never rewrite `source_reviewed`.

Mismatching files are listed in `composition_files` with their source PRs: their merged content includes something the source reviewers never saw (stacking or conflict resolution). They stay `pending`; check only semantics that arise from the combination: one object modified separately by several sources, ordering between migrations and implementation, environment variables and configuration, rules half-changed by one source, and consistency between docs and implementation. Read the listed source PRs with `read-related-pr.ts` when needed to confirm what each source already decided, and do not re-report problems already settled there.

Files whose source was not reviewed, that have no source PR, or that were committed directly are reviewed normally.
