# Deploying Central PR Review

## Upstream and Production Sync

`Yikai-Liao/agentic-review` is the public development repository; `Qiyin-Tech/agentic-review` is a separate internal copy. Each runs its own central review with its own apps, Worker, and credentials; syncing source does not change runtime configuration.

| Setting | Personal deployment | Organization deployment |
| --- | --- | --- |
| `CONTROL_REPOSITORY` | `Yikai-Liao/agentic-review` | `Qiyin-Tech/agentic-review` |
| `ALLOWED_OWNER` | `Yikai-Liao` | `Qiyin-Tech` |
| `REVIEW_LANGUAGE` | `en` | `zh-CN` |

Each deployment sets `AGENTIC_REVIEW_PRODUCTION=true` in its own central repository and stores its own Review App private key and model API key. Logs and artifacts of the public central repository are publicly readable, so the personal Review App is installed only on personal public repositories meant for review. The personal repository enables only `Agentic Review` and `Agentic Review Execution`; the organization sync and Lark renewal workflows stay disabled there.

Both the personal and organization Review Apps and Dispatcher Apps use `Only on this account`. Each Review App is installed on its own target repositories and each Dispatcher App only on its own central repository. Each Worker uses its own webhook secret and Dispatcher credentials.

The organization repository's `sync-upstream.yml` tries to fast-forward `main` from the public repository every five minutes and also supports `workflow_dispatch`. GitHub schedules may lag; until a sync succeeds, production keeps running the previously synced version. Syncing uses a writable deploy key bound only to the organization repository; its private key lives in that repository's `UPSTREAM_SYNC_SSH_KEY` secret and never reaches the review agent. Syncing creates no merge commits, never force-pushes or deletes branches, and copies no PRs, issues, Actions runs, or secrets. A diverged organization branch or rewritten upstream history fails the sync explicitly.

The organization repository's `main` has a repository ruleset: no force-push or deletion, and only deploy keys may bypass updates so upstream commit SHAs are kept and direct commits or merged PRs on the organization side cannot cause divergence. The organization-level `Protect Default Branch` excludes this repository and is otherwise unchanged. Do not add other writable deploy keys; GitHub's bypass applies to the deploy key type, not to a single key. Merge permission on the public repository's `main` decides which code reaches production.

All changes land in the public repository first. Older PRs, issues, and runs on the organization side are kept for history; new development is not merged there.

To sync immediately, run `gh workflow run sync-upstream.yml --repo Qiyin-Tech/agentic-review`, check that repository's `Sync Public Upstream` run, and compare the `main` SHAs of both repositories. When a sync fails, production keeps its current version; fix the upstream or organization-side divergence per the error and run it again.

## 1. Dispatcher App

Create a private Dispatcher GitHub App under the account or organization that owns the central repository:

- webhook disabled;
- only `Actions: read and write`;
- installed only on the central repository.

The Worker uses it to trigger the central repository's `agentic-review.yml`, never to access target repositories.

## 2. Worker

Worker secrets:

- `WEBHOOK_SECRET`: the Review App webhook HMAC secret;
- `DISPATCH_CLIENT_ID`: the Dispatcher App client ID;
- `DISPATCH_PRIVATE_KEY_PKCS8`: the Dispatcher App's PKCS#8 private key.

Deployment vars:

- `CONTROL_REPOSITORY=owner/agentic-review`;
- `CONTROL_WORKFLOW_REF=main` or a fixed tag;
- `ALLOWED_OWNER=<target owner>`;
- `REVIEW_BOT_MENTION=@<actual-app-slug>`: required; the GitHub mention form of the Review App's actual slug.

```bash
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put WEBHOOK_SECRET
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_CLIENT_ID
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_PRIVATE_KEY_PKCS8
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml deploy
```

## 3. Review App and Central Repository

Create the Review GitHub App with these repository webhook events, and install it on every target repository, every same-owner linked repository that needs querying, and the central repository:

- `pull_request`: keeps `opened`, `reopened`, `synchronize`, and `ready_for_review`;
- `issue_comment`: receives `created` for plain PR comments;
- `pull_request_review_comment`: receives `created` for inline thread comments.

Edited comments start no new task; the Worker also drops mentions by the bot itself and mentions inside quotes, code blocks, and inline code. `REVIEW_BOT_MENTION` must be set explicitly to the mention form of the Review App's actual slug. The central publisher derives `REVIEW_BOT_LOGIN=<slug>[bot]` from the `app-slug` output of `actions/create-github-app-token`; do not configure a separate bot login by hand. Comment bodies enter the dispatch input verbatim; all `workflow_dispatch` inputs share GitHub's 65,535-character total limit, and oversized requests fail explicitly without truncation. Do not compute your own per-field or HTTP JSON UTF-8 byte limits; see [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs).

Manual reruns also accept merged PRs; closed, unmerged PRs are still rejected. Even when the source branch or fork is gone, code is fetched and reviewed by the base/head SHAs GitHub stored on the PR, with no need to restore the branch. `automatic` requests must still submit SHAs matching the PR's stored snapshot; results and the Check stay on the original PR and original head.

App repository permissions, at least:

- `Contents: read and write` (needed by GitHub GraphQL review thread resolve/unresolve; write is minted only for the trusted publication step after the agent ends);
- `Issues: read`;
- `Pull requests: write`;
- `Actions: read`;
- `Checks: write`;
- `Metadata: read` (GitHub default).

Central repository Actions variables:

- `AGENTIC_REVIEW_PRODUCTION`: set to `true` to enable central review;
- `REVIEW_LANGUAGE`: required report language, `zh-CN` or `en`. Missing or other values fail before the Review token is minted. This variable belongs to the central runtime repository and controls, for every target repository, the summary, findings, status reasons, request replies, fixed publisher text, and Check messages; JSON schema fields and enum values are never translated;
- `AGENTIC_REVIEW_CLIENT_ID`: the Review App client ID;
- `REVIEW_AGENT_MODEL`: a model ID accepted by the Responses API, such as `gpt-6-luna`, `deepseek-flash`, or a gateway alias; the workflow registers the ID explicitly, so it need not appear in Pi's model catalog;
- `REVIEW_THINKING_LEVEL`: required reasoning level such as `xhigh`, shared by model calls and the publication footer; the review fails explicitly when unset;
- `REVIEW_FAST_MODE`: optional; `true` requests fast mode, `false` or unset keeps the API's default service tier, and other values fail before the Review token is minted. Request parameters and fallback rules are below;
- `REVIEW_AGENT_BASE_URL`: base URL of an API supporting `/responses`;
- `AGENTIC_REVIEW_LARK_APP_ID`: the Lark custom app ID;
- `AGENTIC_REVIEW_LARK_ROTATOR_CLIENT_ID`: client ID of the Lark Secret Rotator GitHub App.

Central repository Actions secrets:

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`: the Review App private key;
- `REVIEW_AGENT_API_KEY`: the model API key.

Never put these secrets in target repositories. Target repositories need no `.github/workflows/review.yml`.

## 4. Lark User OAuth and Automatic Renewal

Central review has paused Lark evidence and judgment: the review job does not install the Lark CLI, read the `lark-review` environment, inject Lark credentials, or wait for token verification. Authorization, hourly token renewal, and the setup below are kept for a future restore; downstream Lark links currently only identify sources and trigger no queries or warnings for unread material.

For first-time setup, linking personal documents after `.env`, or switching apps or users, follow the [Lark app and authorizing user guide](lark-operations.md) first. This section covers production configuration and renewal.

### Where the Login Lives

Each Actions runner is a fresh machine. What persists is the OAuth token; after a restore, the CLI uses the UAT through environment variables each round. The CLI login directory is never cached and `auth login` never runs during review. One authorized enterprise user identity maps to one renewal chain:

```text
You authorize the Lark app in a browser (required read-only scopes + offline_access)
  → the trusted renewal job receives a UAT and a refresh token
  → the lark-rotation environment stores the refresh token
  → the lark-review environment stores the UAT
  → the UAT is kept and renewed; central review does not consume it for now
  → after a restore: the review job injects the UAT and the official lark-cli --as user reads material
```

The scheduled job owns the refresh token exclusively and saves the next refresh token before publishing the UAT. The App Secret and the GitHub token that writes environment secrets are used only in the renewal job; the review `GH_TOKEN` stays read-only.

### Create the Lark App

1. In the [Lark developer console](https://open.feishu.cn/app), create a custom app such as `Agentic Review`. This setup uses no bot capability and needs no OAuth callback or persistent runner.
2. Request `offline_access` and these read-only scopes for the **user identity**:
   - `search:docs:read`: search docs and wikis visible to the user;
   - `docx:document:readonly`: read document bodies;
   - `wiki:node:retrieve`: resolve wiki nodes and space IDs;
   - `drive:drive.metadata:readonly`: read document metadata;
   - `base:app:read`, `base:table:read`, `base:field:read`, `base:view:read`, `base:record:read`: read base structure, view configuration, and issue records.
3. Publish an app version and pass admin review. The app's availability must include the maintainer account that performs OAuth.
4. Use a dedicated review app with only this read-only set; do not reuse an app that has document write permissions. `--as user` and `STRICT_MODE=user` only pin the identity; the real read/write limit comes from the OAuth scopes. `offline_access` yields a refresh token and grants no document access. Store the App ID in the central repository variable `AGENTIC_REVIEW_LARK_APP_ID`.

### Token Rotation Permissions

In the central repository under Settings → Environments, create `lark-rotation` and `lark-review`, allow the default branch `main`, and set no required reviewers or wait timers. Private repositories need a GitHub plan that supports environment secrets.

Create a separate `Lark Secret Rotator` GitHub App: webhook disabled, only `Environments: read and write`, installed only on the central repository. Writing environment secrets actually requires that permission, not the repository secret permission `Secrets: write`. Only `.github/workflows/lark-token-refresh.yml` uses it; it neither reuses nor widens the Review App's permissions.

Set these initial values. Without `--body`, `gh secret set` reads the secret interactively; never put secrets in command-line arguments, chat, or logs:

```bash
gh variable set AGENTIC_REVIEW_LARK_APP_ID --repo Qiyin-Tech/agentic-review --body '<Lark App ID>'
gh variable set AGENTIC_REVIEW_LARK_ROTATOR_CLIENT_ID --repo Qiyin-Tech/agentic-review --body '<GitHub Rotator Client ID>'
gh secret set AGENTIC_REVIEW_LARK_APP_SECRET --repo Qiyin-Tech/agentic-review --env lark-rotation
gh secret set AGENTIC_REVIEW_LARK_ROTATOR_PRIVATE_KEY --repo Qiyin-Tech/agentic-review --env lark-rotation < /absolute/path/to/rotator-private-key.pem
```

The two automatically rotated tokens are not initialized by hand:

| Environment | Secret | Used by |
|---|---|---|
| `lark-rotation` | `AGENTIC_REVIEW_LARK_REFRESH_TOKEN` | the serialized renewal job |
| `lark-review` | `AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN` | kept for the review job after a restore |

[GitHub reads repository secrets when a workflow is queued and environment secrets when a job starts](https://docs.github.com/en/actions/reference/security/secrets#when-github-actions-reads-secrets). Dynamic tokens therefore must be the environment secrets above, with the renewal lock at the job level, so a queued job never gets an already consumed refresh token and a queued review never pins a stale UAT. Do not store repository secrets with the same names.

### First Authorization or New User Scopes

To add user scopes, enable and publish them in the Lark app console first, then update `larkScopes` in the authorization script and merge to the default branch, then authorize again with the flow below. Ordinary `refresh-lark-user` renewal never widens the original grant.

After the PR merges, run this with a maintainer GitHub account that can act on the central repository:

```bash
gh api --method POST repos/Qiyin-Tech/agentic-review/dispatches \
  -f event_type=authorize-lark-user
```

`repository_dispatch` loads only the trusted workflow on the default branch, so code holding central credentials is never picked from a PR branch. Immediately open the Lark verification URL in the **Refresh Lark User Token** run log and confirm with the maintainer's own account. The workflow obtains a UAT and a single-use refresh token through Lark device flow and creates:

- `AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN`;
- `AGENTIC_REVIEW_LARK_REFRESH_TOKEN`.

Pick the enterprise identity that should read material during authorization; afterwards confirm the workflow succeeded and both environments hold the token secrets. Review does not consume Lark credentials now and works before the first authorization; a restore must verify the identity and tool preparation again.

The workflow then renews hourly in series. Each OAuth request consumes the refresh token once; only secret writes retry the same value, up to five times, without exchanging the token again. Schedules are not punctual; token lifetimes follow the OAuth response and run log. This is an automatic renewal chain, not a login that never expires.

When the UAT expired but the refresh token is still valid, or the new refresh token was saved but the UAT write failed, send a **new** refresh event:

```bash
gh api --method POST repos/Qiyin-Tech/agentic-review/dispatches \
  -f event_type=refresh-lark-user
```

When authorization is revoked, the refresh token is invalid, or a new refresh token was lost before being saved because a write failed or the runner died, send `authorize-lark-user` again and confirm. Secret retries cannot make Lark and GitHub writes one atomic transaction; a lost new refresh token cannot be recovered from the old one. Do not copy old tokens or turn failures into success, and never consume this renewal chain locally in parallel.

### Verifying the Main Tenant and Three Sub-Tenants on Restore

Readable material is **the app's enabled user scopes ∩ the scopes the user granted ∩ the document and table permissions of the current enterprise user identity**. User OAuth does not require adding the app to each document; owners must share material with the authorizing identity.

Switching tenants with the same phone number is not the same OAuth identity, so one UAT is not guaranteed to cover the main tenant and the three sub-tenants. Pick a representative Docx, wiki, and base for each, confirm sharing under the identity chosen during authorization, then actually read them through the API; cross-tenant sharing policies and API support may still limit access. Material visible only after switching identities needs sharing fixed first or a separate multi-identity design; cross-tenant reading is not promised.

A restore must prepare and verify a pinned official Lark CLI before the agent starts, then verify the current UAT with `lark-cli api GET /open-apis/authen/v1/user_info --as user` and check the success response. That proves only a valid login, not document permissions; in external token mode the CLI disables `auth` management commands, so `auth check` and `auth status` cannot serve as acceptance.

Accept with a PR that needs the test links: the workspace should contain the relevant body from `docs +fetch`, the read result after wiki resolution, and the base's tables, fields, and raw values of the target records. A successful login check or an overall successful review never replaces these actual reads. Handle permission errors by layer: a missing scope needs enabling and publishing in the app console and a fresh user authorization; insufficient document ACL needs sharing with the authorizing identity; missing base records need the user role's row and column permissions checked.

Bases with advanced permissions also follow the user role's table, field, and record scope. The Lark CLI never bypasses user ACLs; third-party iframes such as Figma still yield only the link or placeholder metadata Lark returns.

### Downstream Rules

These rules apply after a restore; the current central entry's pause takes precedence. Lark reading follows `central/lark-context.md` with no pre-merged source allowlist. Downstream repositories may add long-lived links, business triggers, and table status semantics in `.agentic-review.md`, for example:

```markdown
## Lark Known Issues

- When order, payment, or refund status changes, query the refund PRD
  `https://example.feishu.cn/wiki/wikcnRefundPRD`, the acceptance record
  `https://example.feishu.cn/docx/doxcnRefundQA`, and the issue table
  `https://example.feishu.cn/base/bascnIssues?table=tblIssues` as needed; skip them for other changes.
- "Scheduled" in the issue table means planned only; only "Accepted" or an acceptance conclusion in the body means fixed.
```

The agent may read explicitly mentioned links as the review needs, follow related referenced documents it has access to, and never search documents on its own; records inside a base are located with filters and minimal field projection.

## 5. Verifying Review Publication Permissions

Each central workflow run mints three installation tokens:

| Token | Repository scope | Use | Permissions |
|---|---|---|---|
| read token | target owner's repositories with the Review App installed | checkout, the shaftoe action, `GH_TOKEN`, `gh` in Pi bash | `contents: read`, `issues: read`, `pull_requests: read`, `actions: read`, `checks: read` |
| check token | current target repository only | creates the Check linked to the current Actions run before the agent starts | `checks: write` |
| publication token | current target repository only | the trusted publication step after the agent ends | `contents: write`, `pull_requests: write`, `checks: write` |

Before the agent starts, the trusted workflow fixes the read token's readable set to the target owner's repositories with the Review App installed; the target PR cannot add repositories or permissions. Within that fixed set, the workflow's automatic association index or explicit stable issue/PR references in review input such as `.agentic-review.md` may select private records not declared at the merge base for on-demand reading; this is the intended product boundary and needs no merge-base pre-authorization. A link only creates a query entry and proves neither candidate relevance nor business authorization. The agent reads project status semantics by the PR head and queries only when a current finding needs it. One installation token cannot cross GitHub owners; private repositories of other owners need a separate installation and token design.

The `check token` creates the Check before Pi starts. The publisher uses the sealed and verified request identity, rechecks result schema, scope, coverage, and that root comments belong to the current PR, and only after it publishes the review, replies to threads, and resolves or reopens them can completion mark success. GraphQL `resolveReviewThread`/`unresolveReviewThread` actually require `contents: write` besides `pull_requests: write`; that higher-privilege token is minted only after the agent ends and goes only to the publication and Check completion steps, never into the agent shell or action input. Review and publication share one job and runner; `prepare-review-context.ts` handles the full preparation of code, history, and input, and `publish-review-run.ts` handles trusted validation, assembly, and publication. The publisher's pinned control code is packed into a preparation step output before the agent starts and restored from the Runner's saved output into a fresh temporary directory after the agent ends, avoiding a second checkout; rewritten local scripts never take part in publication. The request context is still checked against the preparation step's SHA-256 digest, and a missing digest or changed context blocks publication. When the request digest is fixed but later input preparation fails, the scope can still be saved; no review is published unless the agent finished successfully. After successful assembly `workspace_ready` is recorded, and successful and failed workspaces are archived once by outcome, keeping the scope and any publication report. Automatic resolve/reopen follows the review conclusion regardless of who opened the thread. The custom `submit_review` extension reads no token; it only validates and persists the agent's result object, and failures never advance the complete audit checkpoint.

Before the agent starts, the review job checks that `rg` (ripgrep) is available; if missing it installs it through the Ubuntu package manager, otherwise reuses it, and runs `rg --version` to verify. Installation or verification failure stops the round so the agent never retries during investigation for a missing search command.

The review job uses Pi's native retry: `retry.baseDelayMs: 15000`, waiting 15, 30, and 60 seconds between consecutive retries, with everything else at the defaults of Pi 1.3.0 bundled in the current action. The central model window is `272000`, shared by input and output, with a per-call output limit of `25000`. Startup material preloading uses the same window for its budget.

Context is managed by [`pi-fold`](https://github.com/shaneconner/fold), pinned by the workflow's `PI_FOLD_VERSION` and installed and cached by version before the agent starts. At 80% of the window it folds the earliest completed tool batches into short code-generated summaries while the original stays in the session JSONL. The whole review is one unfinished user turn, and pi-fold treats that turn's first user message (the startup prompt and preloaded rules) as unfoldable; an integration test submits several consecutive folds with a ~100KB prompt and the last request still contains the full prompt. Whether preloaded review material can be folded is not separately verified. Folding calls no model, so there is no slow summary request like native compaction: PR #129's self-review once triggered native compaction at 256K, the summary request ran 58 seconds and failed, and the whole round was lost. pi-fold truncates `read` results over 16KB to the first 16KB and writes the full content to `pi-fold-evidence/` in the session directory, readable by path; bash output is saved separately only when Pi itself truncated it. This truncation cannot be disabled; across 134 historical sessions only 18 `read` calls exceeded 16KB, since reviews read code mainly through bash.

Pi settings `compaction.enabled` and the action's `auto_compaction` stay `true`: pi-fold folds before the compaction threshold, and native compaction only catches overflow left after folding. When native compaction fails, `review-runtime` prints the failure reason first and then aborts the round.

The central workflow offers no model-invoked compaction, decompression, or context search tools; pi-fold's own `pi_fold_context` is not added to `loaded_tools` either. The earlier `billion-context-pi` let the model schedule compaction itself; a 3-file change in frontend PR #483 produced 74 turns, 21 manual compactions, and repeated rule recovery, a clear latency regression. Trusted rules are still preloaded directly; a body is reread only when the current step needs it and it has really been lost, and after investigation the agent refreshes the discussion and submits.

Native behavior has known limits: Pi 1.3.0 matches `billing` against the full error text, so a TPM error containing a `/account/billing` help link is classified as non-retryable; this project no longer rewrites or reclassifies it, and isolated acceptance kept that real failure. Ordinary-turn native exponential backoff does not parse `Please try again in …s` in the body. The provider layer's server wait cap defaults to 60 seconds, and errors over the cap may still be retried by the native session or summary budget; do not describe the default as always waiting the full hinted time. Raw errors and failed results are kept, and exhausted or non-retryable errors never publish a successful review.

The agent's time budget is 9 minutes (`REVIEW_TIME_BUDGET_SECONDS=540`); the `Run Pi review` step runs at most 15 minutes and the review job at most 30, leaving time for model calls finishing past the budget, preparation before review, and publication and uploads afterwards. Exhausted retries still fail, and the publisher keeps the workspace. If rate limits stay frequent under a fixed TPM, reduce per-call input or concurrent requests; more retries cannot raise throughput quota. Pi configuration and extension interfaces are in the [Settings Reference](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/settings.md#network-and-retries) and [Extensions](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/extensions.md).

After changing request recovery or summary boundaries, run isolated acceptance with the SDK matching the action besides the regular tests. The test below connects only to a local mock HTTP/SSE server and covers real auto-compaction, in-stream recovery, and session persistence without calling a model API or adding production dependencies:

```bash
pi_sdk_check_dir="$(mktemp -d)"
npm install --prefix "$pi_sdk_check_dir" --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.3.0
PI_SDK_DIRECTORY="$pi_sdk_check_dir/node_modules/@earendil-works/pi-coding-agent" pnpm exec tsx --test test/pi-runtime.integration.ts
rm -rf "$pi_sdk_check_dir"
```

After changing the pi-fold version, extension load order, or window configuration, verify real loading, folding, and session persistence with the action's release artifact. The test has a mock model read evidence repeatedly to push the window past the threshold and confirms several consecutive folds, no summary request, and the full startup prompt still in the window:

```bash
pi_fold_check_dir="$(mktemp -d)"
git clone --depth=1 --branch v2.30.1 https://github.com/shaftoe/pi-coding-agent-action.git "$pi_fold_check_dir/action"
npm install --prefix "$pi_fold_check_dir/extensions" --ignore-scripts --no-audit --no-fund --no-package-lock --legacy-peer-deps pi-fold@4.3.0
PI_ACTION_DIRECTORY="$pi_fold_check_dir/action" PI_FOLD_DIRECTORY="$pi_fold_check_dir/extensions" pnpm exec tsx --test test/pi-fold.integration.ts
rm -rf "$pi_fold_check_dir"
```

With `export_session_jsonl` enabled, the action uses natively persisted sessions. Each run archives the raw JSONL under `~/.pi/agent/sessions/` (including fold and native compaction records) and `pi-fold-evidence/` as `review-session-<repository-id>-<pull>-<source>-<run>-<attempt>`, kept for 7 days. The upload runs after the agent succeeds, fails, or is cancelled, independent of the action finishing its export, so content already on disk survives exceptions or timeouts before export; content lost with the runner or never written cannot be recovered. Logs contain system messages, tool definitions, input, replies, tool results, and native compaction records for reconstructing the investigation. The archive excludes the parent `auth.json` and runtime configuration. The first turn also logs `[review-cache-prefix]` hashes of the fixed prefix, tools, system messages, and rules, without bodies, to locate cross-run differences quickly. With unchanged rules and tool configuration, extra material sits after the fixed rules and cannot change the prefix before the fixed breakpoint.

With `REVIEW_FAST_MODE=true`, `Configure Pi runtime` sends one short Responses request to the configured gateway before the agent starts to probe `service_tier: "priority"` ([OpenAI fast mode](https://developers.openai.com/api/docs/guides/fast-mode)). When the response confirms `priority`/`fast`, the parameter is written into Pi's model configuration; when the gateway or model explicitly rejects it (HTTP 400/422) or the response does not confirm the priority tier, the round keeps the API default. The review itself uses Pi's native request path without wrapping fetch or probing again. Authentication, quota, rate limit, network, and unrelated parameter errors during the probe fail the preparation step; with the switch off there is no probe and the API project's own default tier is not overridden. Fast mode may cost more per token, and the extra startup probe is not counted in the review session's token and cost statistics.

Publication fails soft: a failed shared input check stops all writes; after it passes, the body, each finding, the request reply, each thread's status sync, and evidence replies run separately, and an error blocks only the steps depending on that operation. A failed query is never treated as an empty list for further writes. The body and findings are separate requests so one invalid line cannot block every result; stale earlier threads do not affect other results either. Workspace upload and publication are ordered by actual dependencies, and an upload failure does not block GitHub writes already prepared.

Before publication `review-workspace-<repository-id>-<pull>-<source>-<run>-<attempt>` is uploaded with `notes.md`, file progress, the result, and the trusted scope; when the agent or publication fails, the next round can still recover its unfinished scope. After successful publication, `publication-report.json` is archived with `review-completed-workspace-<repository-id>-<pull>-<source>-<run>-<attempt>` and no separate success report is uploaded. On publication failure the report is stored alone in `review-publication-<run>-<attempt>`; when draft assembly or archiving fails, the raw diagnostic draft is stored separately and never used as recoverable scope. Workspace naming and history lookup stay consistent.

`publication-report.json` is saved after the summary and coverage are written and records publication operations with their dependencies, results, and errors, including the results of those two outputs. The Actions summary records earlier GitHub operations; Check details are written last and list every earlier operation, including the report's own storage result and the coverage write-back after a storage failure; a failed Check details write also writes back coverage, with its result only in the process log. The process log summarizes every operation last. When any operation fails or is blocked by a failed prerequisite, the publisher finishes the rest and exits non-zero, coverage stays `draft`, and the complete audit checkpoint does not advance. A failed report store or completed workspace upload likewise cannot make the Check succeed. When everything succeeds, the body and replies carry no execution notes; when operations failed or were blocked before the body or request reply was published, they open with the failure count. Earlier statuses in the body are review judgments; actual execution results follow the run report.

On a rerun of the same run, the publisher reads every page of this bot's publication markers and reuses published bodies, findings, and replies; execution notes in the body are updated to this run's results, and resolve/reopen rechecks the remote state. Markers bind the run, target PR, head, operation, and content. A failed write request may still have taken effect remotely, so the round does not retry blindly; the next run checks markers first. GitHub writes and network responses are not atomic, so exactly-once publication cannot be guaranteed while the remote state is not yet visible.

### One Review per Round and Collapsing Old Summaries

This round's new findings are published as `comments[]` with the summary in one `POST /pulls/{n}/reviews`, adding a single timeline entry. GitHub rejects the whole review when any line is outside the diff, so `submit_review` checks each finding against the right-side hunks of `git diff -M --unified=3` and, when out of range, returns that file's commentable ranges for the model to fix; publication does not retry finding by finding. Findings that cannot bind to a diff line (`line: null`) attach to a changed file of the PR: the review creation `comments[]` does not support file-level comments, so the publisher posts each one with `POST /pulls/{n}/comments` and `subject_type: file` before the summary, each adding its own timeline entry; if any fails, the summary is not published and a rerun completes it. Once the summary exists, every discussion it lists exists too, so later reviews reading the PR never miss them. Like inline findings these have thread state, count toward the title and index, and can be marked and closed in the next round. `submit_review` checks that `path` is a file changed by the PR.

The summary's first line carries the publication marker and the `agentic-review:automatic-summary` marker; the second line is the publisher's title. After a new automatic summary is published, the publisher uses `PUT /pulls/{n}/reviews/{id}` to rewrite this bot's earlier, not yet collapsed automatic summaries on the same PR to a single line pointing at the superseding review (with the `agentic-review:superseded` marker), keeping the original in an expandable `<details>` that the next round's input can still read. Order is by review ID; a rerun of the same run collapses only summaries older than its own and completes collapses that failed last time; reruns never restore collapsed summaries. New versus old follows run order, not publication order: every automatic write (summary, inline and file-level discussions, status marks, replies) carries the run number in its publication marker (`automatic-run:<run_id>`), and thread resolve/unresolve leaves no text, so it runs after that thread's marks and replies are written. Automatic reviews of one PR run serially through the concurrency group, and reruns keep the original run number, so a write on the PR with a larger run number means this run is a rerun of an older run. The prerequisite "confirm there is no newer review" then fails, discussions, summary, statuses, and collapsing are all skipped, the Check fails, and the later review's conclusions stay. The check must read the review and comment lists; a failed read also writes nothing. Replies to comment requests may cover only part of the scope, so they neither collapse other summaries nor get collapsed. Collapsing changes only the summary body; inline discussions under it are unaffected.

With no new findings, no thread status changes, and a title matching the latest automatic summary, the publisher updates that summary in place instead of creating a review. The in-place update appends the new publication marker after the existing markers on the first line; the new marker carries this run's number, which stops writes from reruns of older runs. When closing an earlier problem, the publisher writes a status mark with the `agentic-review:status` marker at the top of a root this bot created, then resolves it without a reply; it replies only on reintroduction, severity increase, or when the root was not created by this bot. Each collapse, mark, and reply is a separate publication operation; failures count in the run report and Check conclusion and do not affect the new summary already published.

### Comment Requests, Scope, and History

A comment enters the central workflow with only its body and identity, without pinned base/head; the workflow reads the current PR snapshot when it actually starts and pins this round's comparison start. Comment tasks never check snapshots against stale SHAs; only automatic `pull_request` events verify the original base/head after queuing and fail explicitly when stale. On ordinary failure paths the runner uploads whatever workspace exists; hard interrupts promise nothing. Comment event bodies keep the full original text.

The central task hands the original text to the agent to judge scope, with priority "explicit natural-language scope > implied thread scope > PR default". A plain PR comment re-investigates the actual scope of the latest PR-level request: without code changes it still gives current evidence; with changes it reviews new changes and their direct impact and fills coverage that failed or was unfinished last time. A thread by default investigates the current problem and its direct impact, widens only when the text explicitly asks for the whole PR, and does not inherit PR-level scope history. Trusted preparation code initializes the default scope and reusable workspace; the agent calls `set_review_scope` only when the scope changes and updates file progress in `review-progress.json`. Trusted code owns request identity and the final `review-coverage.json` history record. The final result uses this round's scope automatically without copying IDs.

The latest PR-level request workspace for a PR is found through control repository Actions artifacts by repository ID, PR, source, run, and attempt, independent of ancestor/base relationships; failed runs, skipped publication, and drafts all count as scope history, excluding thread workspaces and the current run. Not found, expired artifacts, and GitHub API errors are recorded separately; an error is never taken as "no history" to change scope. Earlier workspaces are read-only. A successful complete `audit` checkpoint still needs its own successful Check, commit relationship, and base/head verification; partial success never advances it.

### Per-PR Concurrency Queue

The execution workflow uses a workflow-level concurrency group of `repository_id` and `pull_number`, shared by review and publication; different PRs can run in parallel. It is configured with `queue: max` and `cancel-in-progress: false`: at most one running task and at most 100 pending tasks per PR, and GitHub cancels new tasks beyond that. FIFO follows when tasks started waiting, not the absolute order webhooks were sent. See [GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

The review footer has two lines, with labels in the report language. The first line holds the "workflow run" and "review workspace" links, then the review position (this round's head and the head of the last complete review) and reviewed file counts (including those reviewed by their source PR); the second line holds the model, reasoning level, duration, token count, the dollar cost estimate returned by the Pi SDK, and the rules version. GitHub comments render single newlines as line breaks, so there is no blank line between them. Thread status replies link only the run; run information follows the same round's summary. Costs keep four decimals, show `<$0.0001` below $0.0001, and show "unavailable" explicitly when there are no cost statistics. Explicitly registered models are not in Pi's catalog, so the SDK computes their cost as 0. Before the first request the `review-cost` extension takes prices (including tiered prices) from Pi's model catalog: the exact model ID first; otherwise the highest version of the same family and tier name, for example `gpt-6.1-terra` takes `gpt-5.6-terra`. The latter is an estimate, not the model's real price; the same model may be priced differently across providers, and `openai` is preferred. Gateway aliases without a usable catalog price still review normally, but usage statistics mark the price unknown (`priceKnown: false`), and every cost in the review footer and Check details shows "unavailable" instead of $0.0000. Costs do not represent the gateway's actual bill. The action version is visible through the run link, and the exact review scope follows the workspace.

Central OpenAI Responses requests use a stable `prompt_cache_key: "agentic-review"`. The repository Actions variable `REVIEW_EXPLICIT_PROMPT_CACHE` controls explicit caching: unset or `false` disables it and Pi and the gateway handle ordinary automatic caching; set it to `true` only after confirming the gateway and model support it. The variable maps through the workflow environment to Pi's `compat.supportsExplicitPromptCacheMode`, overriding the catalog's capability declaration for the official service; invalid boolean values fail the preparation step. `supportsLongCacheRetention` controls the long retention parameter and cannot replace this switch for disabling explicit breakpoints.

When enabled, `prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" }` is added at the end of the fixed-rules user message, and `prompt_cache_options: { mode: "implicit", ttl: "30m" }` caches dynamic material. When disabled, neither parameter is sent. The cache extension keeps full message bodies, roles, and order; session headers are still generated by Pi. When enabled, the first request aborts if the fixed rules cannot be located; after long-review compaction has removed the original rules message, the current context is kept and the old message is not reinserted. Actual hits still depend on prefix, lifetime, and server caching. Fixed rules are preloaded directly from the trusted control checkout and no longer installed into Pi's auto-discovery directory, so the system never asks to read the same skill again.

Explicit breakpoints are request metadata and add no prompt tokens or model calls. The 12h fixed prefix and 30m dynamic material request an upstream caching policy and do not decide the gateway's billing. The current gateway bills cache writes uniformly regardless of TTL; cost estimates use the SDK's configured cache write price and add nothing for requesting 12h. The 12 hours count from the write; a hit does not restart them. Cache semantics are in [OpenAI cache lifetime](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime). Cold starts, rule changes, or expired long-term caches still need writes; whether it saves money depends on later reuse count and spacing.

Each model turn's plain input, cache reads, cache writes, output, reasoning tokens, and cost estimates are recorded in the `usage` of the matching assistant message in the session JSONL; run logs no longer print them per turn. `reasoning` is already included in `output` and must not be added twice; plain input excludes both cache items. Costs come straight from the Pi SDK statistics, without rewriting message usage or cost and without requiring the gateway to return TTL write breakdowns. The extension validates standard token and cost values through `message_end`; when the statistics themselves are missing or corrupt it still aborts and removes the old cost file, so publication cannot mask the failure with earlier turns' statistics. Check details show total cache writes and the SDK estimate, not lifetime splits the gateway never promised. Statistics store no prompts, source, comments, or model text and make no extra model requests. Failed turns keep the usage the SDK reported; full session cost still follows the action summary. When comparing before and after a rollout, count first reviews and re-reviews separately and check whether the first turn's fixed-prefix cache writes turned into reads; changing the cache key alone does not guarantee savings.

The same per-turn statistics accumulate in the workspace's `review-usage.json` and are archived with the existing artifact. After validating the values, the trusted publisher shows in the Check details' usage section the turn count, first-turn cache hit rate, first-turn plain input, cache reads, and cache writes, plus cumulative token and cost breakdowns; the hit-rate denominator is the sum of first-turn plain input, cache reads, and cache writes, and zero input is noted separately. Missing reasoning breakdowns show as unavailable, never zero. Breakdowns count only review turns; total cost still follows the action summary; the rules version is also shown as the control SHA for comparison. Missing or corrupt statistics fail publication rather than inventing zeros; the file stores no session text and plays no part in coverage completion or request identity.

The footer is wrapped in fixed metadata markers. When preparing input, reading related PRs, and refreshing discussion, only this region generated by the current Review App is stripped, so run information does not add to the next round's input cost; full statistics stay in Check details and artifacts. Review conclusions, publication idempotency markers, human replies, and other bots' text stay unchanged, and judgment edits outside the statistics still enter the incremental discussion.

The footer links the current Actions run's artifacts, which include the recoverable draft, the completed workspace, or failure diagnostics; retention follows the workflow's `retention-days`, and viewers must be signed in with central repository access. The Check Run's `details_url` points to the central repository's current `${GITHUB_RUN_ID}`. GitHub known-issue queries use the central skill and read-only `gh`.

### Retrospective Data

The PR page serves readers only: the latest summary in full, older automatic summaries collapsed to a one-line pointer, and a short footer. Retrospectives read the table below and never parse statistics from PR text.

| Data | Location | Retention |
| --- | --- | --- |
| Run info, result counts, coverage, usage and cost breakdowns, failed publication operations | `output.text` of each run's Check (`Agentic Review / audit` or `/ requested`) | Kept with the target repository's commits |
| Each round's summary text (older ones inside the collapsed block); findings, status marks, status updates, and human replies | PR reviews, inline threads | Kept with the PR |
| Raw errors of publication operations | Actions summary, `publication-report.json` | Run log retention; artifacts 7 days |
| `notes.md`, session JSONL, `pi-fold-evidence/` | workspace and session artifacts | 7 days |

Check details are generated by the publisher and handed to Check completion through a publication step output, which the agent cannot write; when the publisher never got that far, the Check has only a conclusion and summary. Details list only operation IDs and states, without raw errors. Example query:

```sh
gh api graphql -f query='query($owner:String!,$name:String!,$pull:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pull){commits(last:100){nodes{commit{oid checkSuites(first:20){nodes{checkRuns(first:20,filterBy:{checkName:"Agentic Review / audit"}){nodes{databaseId conclusion text}}}}}}}}}}' \
  -f owner=<owner> -f name=<repo> -F pull=<number>
```

Whether an older summary is collapsed shows in the `agentic-review:superseded` marker on its second line. Session JSONL, `pi-fold-evidence/`, and `notes.md` contain target repository source or quotations, so retention stays 7 days; to analyze an investigation in depth, export them before expiry to a Git-ignored local directory and note it in the report.

If publishing the review fails, check:

1. the Review App is installed on the target repository and the linked repositories to read;
2. the app has `Issues: read`, `Pull requests: write`, and `Contents: read and write`, and the installation accepted the latest permissions;
3. the private key in the Actions secret belongs to that app;
4. the agent's `github_token` and `GH_TOKEN` are still bound to the read token, and the publication token is minted only after the agent ends and passed to the trusted publication step;
5. the publisher's `repository`, `pull_number`, and base/head SHAs come from the webhook dispatch input;
6. the Worker's `REVIEW_BOT_MENTION` matches the Review App's actual slug, and `REVIEW_BOT_LOGIN` in the central workflow's publication environment is that slug plus `[bot]`.

## 6. Verification

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm dlx wrangler@4.123.0 deploy --dry-run
```

On a test PR, confirm in the central workflow log that the agent's `gh` uses the read token and that one GitHub pull request review was created rather than a plain issue comment.
