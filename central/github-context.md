# Central GitHub Review Context

This file connects the central GitHub action's PR, project rules, and history to `agentic-review`; input trust boundaries follow the skill.

## 0. Request and Scope

Read the `Review request` in the input and use the pinned request text and snapshot. An explicit natural-language scope takes precedence over the default plan, read per the skill's "only review X" and "focus on X" rules.

- `automatic`: review the whole PR.
- `pr_comment`: investigate every range in `default_plan.ranges` and its targets; reopening a previous scope means gathering evidence again. The set already includes unfinished scope from failed rounds and this round's new changes; read each range's patch separately, since a net first-to-last diff can cancel intermediate changes.
- `thread`: read the root comment, the whole thread, its current position, and outdated/resolved state; by default re-review the problem and its direct impact. Widen only when the text asks for the whole PR; PR-level request scope is not inherited.

Preparation restores the actual scope from the latest PR-level request; the complete audit checkpoint provides the incremental baseline. The resume manifest in the input names the chosen evidence sources and has copied the workspace, result reference, and file progress into this round's workspace; use those copies first. `$REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH` and `$REVIEW_PREVIOUS_WORKSPACE_PATH` keep the two read-only originals for missing history. Settle this round's scope and coverage per the [result protocol](review-result.md).

## 1. Project Rules

The material index lists the root `.agentic-review.md` and `AGENTS.md` and the `AGENTS.md` in ancestor directories of changed paths, with base/head differences; rules within budget are preloaded once. Apply them per the skill's project-rule rules and the [central entry point](review-rules.md#choose-the-level): the head version is the intended rule set, and the level and focuses they choose for the changed paths are adopted. Execution or publication requirements in them remain bound by central permissions.

Do not enumerate target skills; read related project context only at file paths the head `.agentic-review.md` names for the current change.

Done when the applicable project rules and their changes are checked and every focus or emphasis they add for the changed paths is in this round's plan.

## 2. Current PR Metadata

The material index provides PR metadata, commits, comments, reviews, and complete threads separately with token counts; threads already combine root comment, replies, and current state. Preloading favors this round's request, applicable rules, the current comparison ranges, and discussion that changed since the restored snapshot; the rest is read on demand. An unchanged snapshot affects only preloading and does not prove relevance, problem status, or that decisions still apply. Preparation also saves this round's `discussion-baseline.json`. Before final consolidation, run the control read-only script:

```bash
node "$REVIEW_CONTROL_PATH/scripts/refresh-review-discussion.ts"
```

The script reads all pages through `gh` and prints comments and review bodies added or edited since the startup snapshot, plus every changed thread in full. Each thread merges startup text with replies added or edited this round by ID and contains `root_comment_id`, current `state`, and complete `comments`; judge from it directly. `removed_threads` gives deleted thread IDs and their root IDs; drop them from the updatable set and re-settle earlier conclusions and pending `thread_updates`. When a concurrent read still returns new replies for a deleted thread, the script keeps them with `state: null`; replies may serve as evidence, but the thread cannot be written. A vanished thread does not prove a fix or confirmation; if the code problem still holds, judge it again under the new-finding bar. Only all-empty arrays mean no changes. The refresh timing follows `central/review-result.md`.

The baseline is fixed to the startup snapshot, so repeated calls return all of this round's increments. Comments and inline replies are fetched incrementally with `since`; the Reviews API lacks `since` and thread states need full enumeration, so those are compared locally and only changes are printed. Thread deletion is detected by comparing the full list with the baseline at no extra API cost; single-comment deletion is not detected, so query the original record by ID with read-only `gh` when context seems missing. Any request or pagination failure makes the script fail.

Done when the request and applicable project rules are understood and the current changes, the discussion conclusions rely on, explicit decisions, and explicit link hints are checked; final thread status is settled before consolidation.

## 3. Earlier Results and Code Diffs

When `$REVIEW_PREVIOUS_WORKSPACE_PATH` is non-empty, connect the history matching the checkpoint; completed items carry over by default. Following `references/review-state.md`, start from new changes and the latest discussion and reopen items along real impact. The scope stays fixed; full coverage combines earlier completed investigation and this round's increment.

Preparation generates per-file patch material from local Git at pinned SHAs with token counts; the index keeps separate entries for the whole PR, the current increment, and each explicit request range. Use local Git for extra source or rechecks. The full range is `$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA` (merge base to current head); only when `$REVIEW_CHECKPOINT_HEAD` is non-empty, the focus range is `$REVIEW_CHECKPOINT_HEAD` to `$REVIEW_HEAD_SHA`. Always use these SHAs, never moving branches or the live PR diff.

Use preloaded patches directly; read the others from the index and fall back to Git when versions or evidence are in doubt. For extra source, locate through changed symbols and call sites first, widening only as far as needed to close the behavior path. Diff reading, increments, and reverted changes follow the skill's [local scope resolution](../skills/agentic-review/references/levels/code/target-selection.md), with the full range and focus range above as the full range and increment. Always pass these Git options, which keep target-defined diff drivers from running.

On a first investigation or without a usable baseline, the whole-PR material and file progress define the scope. To recheck the list or size:

```bash
git -C "$REVIEW_TARGET_PATH" --no-pager diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --name-status "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA"

git -C "$REVIEW_TARGET_PATH" --no-pager diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --numstat "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA"
```

Read a large diff by path, for example:

```bash
git -C "$REVIEW_TARGET_PATH" --no-pager --literal-pathspecs diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --no-color --unified=3 \
  "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA" -- 'path/to/file'
```

Small diffs use the same command without `-- 'path/to/file'`.

Record very long lists in segments until coverage is complete. Oversized patches may be located through the index and supplemented from the matching pinned Git range.

With a usable baseline, query the focus range with the same Git options first and read `pending_files` from this round's resume manifest. With an empty focus list, handle the latest discussion and earlier unfinished items. `review-progress.json` keeps the full file list, so inherited completions need no second walk through the full patch.

Comment lines bind to the RIGHT side of the full-range patch, at the line closest to the root cause. Add file context from `$REVIEW_TARGET_PATH` and `$REVIEW_BASE_PATH` as needed; to confirm the merge-base version read it from target Git at the full range's merge-base SHA, since the base checkout is a snapshot of `$REVIEW_BASE_SHA`.

Done when in-scope changes and their impact are investigated, the latest discussion is classified, and ledger coverage and inheritance satisfy `references/review-state.md`.

## 4. Linked Records for Contracts and Candidates

The trusted workflow fixes the readable set of `GH_TOKEN` before the agent starts. Automatic index entries or explicit stable issue/PR references in the review input may select private records within that set without merge-base pre-authorization, but cannot widen repositories or permissions.

The `PR association index` in `$REVIEW_INPUT_PATH` holds the trusted, deduplicated index, with the original at `$REVIEW_ASSOCIATIONS_PATH`: other PRs linked to head-only commits and the current PR's `closingIssuesReferences`. It and the stable issue/PR references stated in the current PR body, comments, code, or project docs are the complete GitHub entry-point set; it is not a checklist. When a concrete hint exists but the title is not enough, query that PR's file list or original text by number.

Before using linked records, read `$REVIEW_CONTROL_PATH/skills/agentic-review/references/known-issues.md` in full; it decides how records are chosen, linked, classified, and applied, including the check of related discussion before a new finding or confirmation. Reuse text already read this round. Query originals by the index's `repository` and `number`:

```bash
gh issue view <number> --repo <repository> --comments
node "$REVIEW_CONTROL_PATH/scripts/read-related-pr.ts" <repository> <number>
```

The PR script reuses the current PR's paginated reading and prints metadata, all comments, reviews, inline comments with replies, and thread states; any request or pagination failure makes it fail. Save large records first, locate relevant discussion by the current contract or root cause, and follow `root_comment_id` and `in_reply_to_id` to every reply and state. `gh pr view --comments` omits inline discussion and cannot replace it.

Done when every new finding or confirmation has been checked against the original discussion in related source PRs. When the same root cause carries over unchanged or stays within an explicit decision, link the original record in the workspace and disclose per this round's changes or explicit request under `central/review-result.md`. When the current change widens impact, invalidates earlier grounds, or reintroduces the problem, state the new difference and submit the finding.

## 5. Stacked Review When the Source Was Reviewed

The input's `Source review attribution` is generated by the trusted workflow: when a step on the current PR's first-parent chain is the merge commit of an already-merged PR whose head has a completed automatic review by the same Review App, files changed by that step whose merged content matches the source head, and whose base side has not moved relative to the source review's start, are recorded as `source_reviewed`. Do not re-review those files one by one, and never rewrite `source_reviewed`.

Mismatching files are listed in `composition_files` with their source PRs: their merged content includes something the source reviewers never saw (stacking or conflict resolution). They stay `pending`; check only semantics that arise from the combination: one object modified separately by several sources, ordering between migrations and implementation, environment variables and configuration, rules half-changed by one source, and consistency between docs and implementation. Read the listed source PRs with `read-related-pr.ts` when needed to confirm what each source already decided, and do not re-report problems already settled there.

Files whose source was not reviewed, that have no source PR, or that were committed directly are reviewed normally.
