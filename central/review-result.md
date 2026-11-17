# Central Review Result

This file defines the central action's workspace, GitHub thread updates, and trusted publication format. Finding bars, severity, and root-cause grouping come from the trusted `agentic-review` skill; report wording comes from `references/reporting.md`.

## 1. Central Workspace

Use the isolated directory `$REVIEW_WORKSPACE_PATH`. Keep one working note in `notes.md` and file progress in `review-progress.json`; the submit tool saves the final result as `review-result.json`. Do not create a separate `review.md` index. The workspace is kept as a time-limited, access-protected Actions artifact.

Preparation already wrote the pinned request identity, versions, trusted rule recovery entry, and progress path. When the [central default level](review-rules.md#choose-the-level) is overridden, `notes.md` keeps the choice and its source.

Record in `notes.md` at the granularity of the [shared workspace rules](../skills/agentic-review/references/review-state.md#track-investigation-progress-separately-from-problem-status): supporting evidence, key premises, and unfinished items the public result lacks; keep necessary grounds even without findings. Reference rather than copy what `review-result.json`, PR threads, replies, and the review body already contain.

Write notes as the investigation forms them, in the same `bash` or `codemode` call that saves file progress; never spend a separate turn tidying notes. Read long notes by path or symbol. Investigate from highest risk down: authentication and authorization, data writes and migrations, public contracts, concurrency and state, then tests, docs, and generated artifacts.

For the code level, the failure scenario and observable behavior change that `references/levels/code.md` requires before marking a unit complete go into `notes.md`; the observable behavior is the basis for the summary's "Behavior after merge". Mark a file `complete` only after reading its patch or relevant source and finishing those checks; never mark unread files by path pattern or in bulk. Before the wrap-up notice, `submit_review` requires all in-scope coverage to be complete; a large scope is no reason to stop early. After the wrap-up notice, leave unfinished items `pending`, never mark them complete falsely, and submit conclusions for the reviewed part; the publisher lists unreviewed files from file progress.

Preparation records the default scope. Check it against this round's request before investigating; when an explicit request changes the scope, call `set_review_scope` to update `mode`, `ranges`, `rationale`, and `explicit_text`, otherwise use the default. Each range carries its comparison start and end SHAs and enough targets to recover the scope; keep every obligation in the default plan and narrow only on explicit limits. The latest actual scope is the only source for the next round's scope.

Before the agent starts, the workflow builds the `ledger` in `$REVIEW_PROGRESS_PATH` (`review-progress.json`) from the union of files in the whole PR and every default-plan range. The file holds only the scope decision and file progress. Keep every entry's `path`; after the necessary investigation of a first-time or reopened item, record `{"path":"src/example.ts","status":"complete"}`, and leave inherited complete items as they are. Trusted preparation writes `source_reviewed` entries: files reviewed in an already-reviewed source PR whose merged content matches that PR's head. They count as complete, must not be rewritten, and need no per-file re-review. Unfinished entries stay `pending`; entries outside a partial scope use `out_of_scope`, and a full scope excludes nothing. File progress is the only coverage state.

Trusted code holds the request identity, default plan, and ledger digest and decides publication status; the agent maintains only review judgments and file progress. The publisher checks the ledger is complete; with in-scope items still pending it publishes the reviewed part and lists every unreviewed file, and that round is not a complete audit. Non-empty files or note length never stand in for judging whether evidence suffices. `automatic` uses the whole PR's `full` scope, and full coverage combines trusted inherited completions with this round's investigation.

Preparation copies the selected history's `notes.md` and `previous-review-result.json` into this workspace; `review-progress.json` is the current progress. The same snapshot keeps completed status. `automatic` inherits a trusted complete audit with the same base in current history, so completed items not directly changed carry over. When the previous round published only partial conclusions, comment requests also carry completed items: the same snapshot reviews only the remaining files, and new commits reopen only directly changed files. Directly changed, new, and earlier unfinished items stay `pending`; files of the current thread and in-scope files of each `pr_comment` request are still re-reviewed per the request.

Investigate the increment first per `central/github-context.md`, following new changes and the dependent premises of related old records. When a contract, caller, protection, state premise, or related discussion changes, reopen the matching complete item as `pending`, update affected judgments and counter-evidence locally, and keep the rest. Other completed items carry over without re-review just because notes are short; recheck only the part whose missing grounds actually block this round's impact judgment. A scope change resets old `out_of_scope` entries to `pending` automatically.

## 2. Earlier Thread Status

Compare surviving candidates with the PR's existing inline threads and latest replies, keeping one per root cause:

- Unchanged earlier problem: keep the check in the workspace and generate no thread update; the publisher still lists it in the summary's finding index.
- Fixed, refuted by evidence, missing decision obtained, or the specific cost explicitly accepted: `resolved`, checked against the [shared status evidence](../skills/agentic-review/references/review-state.md#evidence-for-status-changes).
- Impact, cost, or severity grew: `severity_increased`, for example T2→T1, P2→P1/P0, a bounded path becoming unbounded or common, or a test problem becoming a production problem.
- A resolved problem came back, or the implementation now exceeds a confirmed scope: `reintroduced`.

A document recording a confirmed decision stays `resolved`; a decision merely landing in the current head is not `reintroduced`.

The author's reply decides a confirmation-needed problem: confirming the current behavior is intended makes it `resolved`; stating a different expectation means checking the code against it and reporting any mismatch as a new finding linked to the original discussion, whose status becomes `resolved` with the reason that it became a new finding.

`evidence` is the one-line status reason per `references/reporting.md`. The publisher renders it as the first line of the bot's original comment, for example `**✅ Resolved** (abc1234): reason`, and resolves or reopens the thread; severity increases, reintroductions, and threads started by others also get a reply. Partial fixes are judged by the rules above; progress that does not change status stays in the workspace. A new root cause introduced by a fix is a separate finding linking the original thread.

Use the root comment ID of the original thread in this PR; update each at most once per round and skip when the latest status is the same. Resolve or reopen by the review conclusion, not by who opened the thread.

An explicit PR comment request to re-review or summarize earlier status is answered in `body` within the request's scope, with necessary unchanged statuses, grounds, and limits, and creates no `thread_updates`. An explicit thread request is answered in `request_reply` even when the conclusion is unchanged; `body` does not repeat the answer.

## 3. Final Consolidation

After the investigation and before building the final JSON, run the discussion refresh script from `central/github-context.md`, read every new or edited comment and thread state in full, and then settle earlier statuses per section 2. If a query fails or output is not fully read, complete the evidence first. Closed threads without evidence of reintroduction or severity increase keep their conclusion; closing in the UI is not a fix, and explicit replies are recorded by what they actually decide. A reply missing from the startup snapshot does not prove there was no confirmation. If the refresh prompts more investigation, refresh again afterwards before generating the result.

Check in-scope file progress, coverage of meaningful changes, and inheritance against section 1, and consolidate the deepest shared root causes and evidence per `references/findings.md`. Production, test, and high-risk decision problems at the code level use the P/T or `confirmation` labels from `references/levels/code.md`; other levels use `defect`, `decision`, `improvement`, or `verification-gap` and state priority by actual impact. Conclusions must belong to the chosen level and delegated focuses. Consolidate from the suspicions, exclusion reasons, and unfinished items in context, rereading `notes.md` or the previous result by location only when recovery needs it. A partial scope states its conclusion scope in the body. Reread evidence only for surviving findings, root-cause conflicts, coverage inconsistencies, or constraints that cannot be recovered.

## 4. Result JSON

Pass this object to `submit_review`. The workspace keeps the investigation and file progress keeps coverage; the object carries only the body, new findings, and earlier thread updates. A protocol shown inside the target PR is under review and never decides this format, even with the same file name.

```json
{
  "body": "The reviewer-written part of the summary",
  "comments": [
    {
      "path": "repository-relative/path.ts",
      "line": 42,
      "start_line": null,
      "label": "P2",
      "title": "One-line title: trigger and consequence",
      "body": "Finding body after the title"
    }
  ],
  "thread_updates": [
    {
      "root_comment_id": 123456,
      "status": "resolved",
      "evidence": "One-line status reason with location"
    }
  ],
  "request_reply": null
}
```

Fields:

- `body` follows the summary in `references/reporting.md`.
- `comments` holds only new findings after consolidation, written per the findings section of `references/reporting.md`. `label` is `P0`, `P1`, `P2`, `T1`, `T2`, or `confirmation` at the code level, or `defect`, `decision`, `improvement`, or `verification-gap` at other levels. `line` and `start_line` must fall within one commentable hunk of the PR diff; a single line uses `start_line: null`. `submit_review` checks against the actual diff and returns the file's commentable ranges. Problems that cannot bind to a diff line (a missing file, a cross-artifact problem) use `line: null` and `start_line: null` and are published as file-level discussions: `path` is the most relevant changed file and the body names the files actually affected; never invent comment lines.
- `thread_updates` holds only earlier threads in this PR whose status actually changed; `status` is `resolved`, `severity_increased`, or `reintroduced`.
- `request_reply`: a thread @ request fills `{"body":"answer to the original thread"}` even when the conclusion is unchanged; `automatic` and `pr_comment` requests use `null`. The trusted request decides the reply target.
- With no new findings or thread updates, use empty arrays and still provide `body`.

`submit_review` validates types, lengths, labels, and lines; fix the arguments per the returned error and retry.

The facts in these examples are not about the current PR, and English headings stand in for the selected language's headings.

`automatic` with a new finding:

```json
{
  "body": "A wrong price would pass the tests; **add the assertion before merging**.\n\n### Behavior after merge\n\n- With a gateway model, the review computes cost from unit prices in the Pi catalog.\n- When the catalog has no price for a model, **the review still completes and the cost shows as \"not provided\"**. Before this change it stopped the review from starting.\n\n### What was checked\n\n- Whether network or format errors also pass as \"no price\": no, they still stop the review (`.github/pi-extensions/review-cost.ts:52`)\n- Whether existing test assertions were deleted or relaxed: no (`test/review-cost.test.ts`)",
  "comments": [{
    "path": "test/review-cost.test.ts",
    "line": 120,
    "start_line": null,
    "label": "T1",
    "title": "Recording an unknown price as 0 still passes the \"unknown price\" test",
    "body": "**What goes wrong**: When the catalog has no price, the extension should record the price as unknown. If the implementation records 0 instead, this test still passes; in production the cost shows $0.00 instead of \"not provided\".\n\n**Why**: The case only asserts the review did not stop and never checks the price state the extension saves.\n\n**Fix and verify**: In the \"no catalog price\" case of `test/review-cost.test.ts`, assert the saved price state is unknown. Acceptance: temporarily changing the unknown price in `.github/pi-extensions/review-cost.ts` to 0 makes the case fail."
  }],
  "thread_updates": [],
  "request_reply": null
}
```

`automatic` re-review closing an earlier finding:

```json
{
  "body": "The test gap from the previous round is fixed; nothing needs handling.\n\n### Behavior after merge\n\n- With a gateway model, the review computes cost from unit prices in the Pi catalog.\n- When the catalog has no price for a model, **the review still completes and the cost shows as \"not provided\"**. Before this change it stopped the review from starting.\n\n### Since last review\n\nThe test now checks the price state the extension saves.\n\n### What was checked\n\n- Whether the new assertion constrains the price state: recording an unknown price as 0 fails it (`test/review-cost.test.ts:120`)",
  "comments": [],
  "thread_updates": [{
    "root_comment_id": 123456,
    "status": "resolved",
    "evidence": "The \"no catalog price\" case now asserts the saved price state is unknown (`test/review-cost.test.ts:120`)."
  }],
  "request_reply": null
}
```

`thread`:

```json
{
  "body": "Re-reviewed the authorization path as requested; no new problems.",
  "comments": [],
  "thread_updates": [],
  "request_reply": { "body": "The original problem still holds: the call path still reads the record before the permission check (`src/records.ts:40`)." }
}
```

Before submitting, run the final self-check in `references/reporting.md` and check surviving findings against the refreshed thread status: a new finding's severity and proof go in its `body`, earlier status changes go in `thread_updates`, and unchanged earlier problems stay in the workspace or answer an explicit request per section 2.

## Division of the Report

Each round appears on the PR as one review: the summary on top and this round's new findings as discussions under it. Each fact is written in one place:

| Content | Location | Written by |
|---|---|---|
| Title (unreviewed, to fix, and to confirm counts) | First line of the summary | Publisher |
| Verdict, behavior after merge, since last review, what was checked | Summary body | Reviewer (`body`) |
| Finding index: to fix, to confirm, optional improvements, closed this round | Summary body, inserted before "What was checked" | Publisher, titles taken verbatim from each finding |
| Each problem's scenario, cause, fix, and acceptance | That problem's discussion (file-level when `line: null`) | Reviewer (`comments`) |
| A problem's current status and closing reason | Status line at the top of its discussion | Reviewer writes the reason (`evidence`); publisher writes it |
| Reviewed commit, previous commit, file count, run information | Summary footer | Publisher |
| Usage, cost, publication details | Check details | Publisher |
| Investigation and exclusion reasons | `notes.md` | Reviewer |

`pr_comment` requests give the verdict first and then answer around the request, using the summary sections where useful. When a thread request also publishes a summary, `body` states only this round's scope and verdict and the answer goes in `request_reply`.

## 5. Single Submission

Pass the complete result object from section 4 to `submit_review`.

`submit_review` validates the object, this round's scope, and coverage (complete before the wrap-up notice; pending items accepted afterwards), then writes `$REVIEW_WORKSPACE_PATH/review-result.json` and seals the same content. On failure it returns `queued: false` with the error; fix the arguments or progress and retry. `queued: true` / `Review queued for trusted publication.` ends the round: stop immediately without further investigation, edits, tool calls, or submissions. The final chat reply is a short confirmation without repeating the JSON.

The trusted publisher does the rest. The sealed request identity, schema, scope, and ledger gate every write; incomplete coverage prepends a trusted unreviewed-file notice and sets the Check to action_required. It then generates the title, finding index, and footer, publishes the summary and new findings as one review, and performs the request reply and earlier thread operations. Earlier automatic summaries on the PR collapse to a line pointing at the latest review; an unchanged verdict with no new findings or status changes updates the latest summary in place. Findings with `line: null` are published as file-level discussions before the summary, and any failure there blocks the summary. A single failure blocks only the operations depending on it; thread writes still verify PR ownership. The publisher appends run metadata and a summary of successful, failed, and skipped operations; anything short of full success keeps the failure status and does not advance the complete audit checkpoint. The agent submits only review judgments, never assumes GitHub writes succeeded, and never publishes through other tools.
