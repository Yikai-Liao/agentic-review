# agentic-review

agentic-review provides an installable review skill and a central PR review service built on a GitHub App.

Development happens in [Yikai-Liao/agentic-review](https://github.com/Yikai-Liao/agentic-review): code, PRs, and issues live there. The personal public repository and the internal `Qiyin-Tech/agentic-review` copy each run their own central review with their own private GitHub Apps, Worker, and credentials, and review only target repositories of their own owner. The personal deployment reports in English and the organization deployment in Simplified Chinese, selected by each central repository's `REVIEW_LANGUAGE` variable.

The organization copy tries to fast-forward the public `main` every five minutes; GitHub schedules may lag, and `Sync Public Upstream` can be run manually. Syncing keeps the original commit SHAs and does not copy PRs, issues, runs, or credentials; the organization never commits on its own, and a divergence fails the sync. See [Upstream and production sync](docs/deploy-central-review.md#upstream-and-production-sync).

The `agentic-review` skill reviews requirements, architecture, development plans, and code, combining focuses such as intent alignment, maintainability, reliability, security, and verification as needed. All levels share one set of evidence, finding, and re-review rules.

- **Local use**: install the skill and review existing documents or code changes.
- **Central service**: static code review by default; this round's request or downstream rules may choose another level. Downstream repositories store no model or GitHub credentials.

## Repository Layout

| Path | Contents |
|---|---|
| [`skills/agentic-review/`](skills/agentic-review/SKILL.md) | The installable method: entry, shared protocol, findings, workspace and re-review, report writing, levels, and focuses |
| [`central/`](central/) | Central-only adapters: level selection and test branches, GitHub context, workspace and result protocol, the paused Lark rules |
| `scripts/`, `.github/` | Context preparation, Pi extensions, workflows, and the trusted publisher |
| [`worker/`](worker/README.md) | Cloudflare Worker that verifies, filters, deduplicates, and dispatches webhooks |
| [`docs/`](docs/README.md) | Central review protocol, deployment, and Lark operations |

## Local Installation and Use

To install the released `main` version, run in the target project root:

```bash
npx skills add Yikai-Liao/agentic-review --skill agentic-review --yes
```

To try an unmerged branch, copy the whole `skills/agentic-review/` from that checkout into `.agents/skills/agentic-review/` of an isolated project and invoke `$agentic-review` explicitly. The install command always picks `main`; one host loads only one skill of that name.

Locally you can review uncommitted changes, a commit, a branch diff, or explicitly choose requirements, architecture, or plan. The skill only reviews existing artifacts; it does not author or fix. For example:

```text
$agentic-review Review the uncommitted code for behavior, performance, and test contracts; read-only, no fixes.
$agentic-review Review the goals, scope, and acceptance in docs/requirements.md, with docs/request.md as the original source.
$agentic-review Review state, failure, and recovery responsibilities in docs/architecture.md, not implementation style.
$agentic-review Review dependencies, migration intermediate states, and integration acceptance in docs/plan.md.
```

Method, level and focus selection, and the simplify/harden methods are described in the [skill entry](skills/agentic-review/SKILL.md). Workspace location, retention, delegation, and known-issue sources follow [workspace and re-review](skills/agentic-review/references/review-state.md).

## Central PR Review Flow

```text
GitHub pull_request webhook
  -> Cloudflare Worker (verify, filter, deduplicate)
  -> central repository workflow_dispatch
  -> three short-lived installation tokens
       ├─ read: for Pi, the action, and read-only gh
       ├─ check: creates the linked Check before Pi starts; never given to the agent
       └─ publication: only for the isolated trusted publish job
  -> Pi reviews with the trusted agentic-review skill and keeps notes in an isolated workspace
  -> submit_review seals the final review-result.json
  -> the trusted publisher creates one review, updates earlier threads, and links the workspace artifact
```

The central workflow runs Pi through [`shaftoe/pi-coding-agent-action`](https://github.com/shaftoe/pi-coding-agent-action). The [central entry](central/review-rules.md) defaults to the code level, whose default duties (behavior and intent, security boundaries, reliability and recovery, performance and resource cost, test validity) are defined in [the code level](skills/agentic-review/references/levels/code.md). Central review runs only T1 test distortion by default; T2 overconstraint needs an explicit request, and test economics is excluded.

Runtime preloads the entry, shared rules, report rules, and central adapters, then loads the chosen level and focuses after reading project rules; after context compaction, rules are recovered from the control checkout. The central workspace is `notes.md` plus `review-progress.json`, kept as an Actions artifact.

Downstream repositories choose levels and add project conventions through `.agentic-review.md` or `AGENTS.md`. The review reads both base and head versions of those rules, applies the head version as the intended rules after merge, and reviews changes to the rules themselves. PR data, comments, and project rules form the startup input; diffs are read from local Git at pinned SHAs. The association index is read on demand when recovering contracts or checking candidates, never as full history.

## Permission Boundaries

Each central review uses the same Review GitHub App to mint three short-lived installation tokens:

- **read token**: covers the target owner's repositories with the Review App installed, with only `contents: read`, `issues: read`, `pull_requests: read`, `actions: read`, and `checks: read`; used by checkout, the action, and the agent's read-only `gh`;
- **check token**: covers only the current target repository with `checks: write`; creates the Check linked to the current Actions run before the agent starts and is never given to the agent;
- **publication token**: covers only the current target repository with `contents: write`, `pull_requests: write`, and `checks: write`, and enters only the isolated trusted publish job to create reviews, complete the Check, reply to threads, and resolve or reopen them. GitHub GraphQL requires `contents: write` for `resolveReviewThread` and `unresolveReviewThread`.

The agent's only GitHub credential is the read token. Even if PR content tricks it into `gh pr comment`, `gh pr merge`, or a write API call, GitHub rejects the write.

Before the agent starts, the trusted workflow fixes the readable repositories to the target owner's repositories with the Review App installed. The target PR cannot widen that set, and one installation token cannot cross owners.

Within that set, automatic association index entries or explicit stable issue/PR references in the review input are entry points for reading private records on demand, with no merge-base declaration needed. A link is only a query entry and proves neither relevance nor business authorization. The agent does not widen GitHub known-issue queries by keyword, `git blame`, or commit history.

## Writing a Downstream `.agentic-review.md`

A downstream repository may add `.agentic-review.md` at its root to state, in natural language, rules **only this project knows that change review judgments**. It is not a configuration schema and does not copy central rules.

Good content:

- review levels and what they apply to, one or several per path, file type, or kind of change, such as requirements documents as requirements, design documents as architecture, development plans as plan, or core modules at both architecture and code; code is the default;
- extra focuses, such as simplicity, structure, or verification sufficiency, and the changes they apply to;
- review criteria on any aspect the project cares about, each marked required or preferred;
- project-specific review emphasis and triggers, such as tracing tenant ownership when authentication changes or consumer compatibility when events change;
- business invariants and high-risk boundaries: state transitions, tenant ownership, money, business dates, idempotency, compatibility;
- call relationships, consumers, generated files, and non-executable areas the code does not reveal;
- real data sizes, batch sizes, concurrency, pagination, or latency limits for performance review;
- which GitHub issues, earlier PRs, test records, or project records count as known issues, how they affect judgments, and what project status fields actually mean;
- full addresses of GitHub repositories to query together, the code paths or business objects that trigger the query, and stable issue/PR links or numbers;
- existing project context that should not be duplicated here, referenced by file path with its trigger and use, for example `.agents/skills/order-domain/SKILL.md`.

State facts and conditions directly: when to check what, where the grounds are, and what counts as done. Use stable paths, fields, issue labels, record IDs, or repository addresses so the agent can find the grounds.

Bind emphasis to concrete paths, file types, business objects, or change signals to order the investigation; it never excludes other diffs from review. Leave out role-play, generic "review carefully", and full copies of current known issues. Any project preference, including style, naming, dependencies, or API shape, is a review criterion: say whether it is required or preferred and which changes it covers; breaking a required one is reported as a defect, departing from a preferred one as an improvement.

Level selection takes an explicit choice in this round's request first, then Head `.agentic-review.md`, then Head `AGENTS.md`, and code otherwise. Project rules may choose one or several levels for the whole PR or by path, file type, or kind of change, including an architecture review of code changes; paths no rule covers stay at code. A level choice never narrows the PR file scope or changes execution or publication permissions.

Central review does not enumerate the target repository's skills; it reads only paths `.agentic-review.md` names explicitly for the current change. Execution permissions, the shared evidence bar, and the trusted publication protocol stay defined by the control checkout.

A natural-language example; titles and structure may follow the project:

```markdown
# Review Rules for This Repository

## Levels

- Requirements documents under `docs/requirements/` use the requirements level; design documents under `docs/architecture/` use architecture; everything else defaults to code.
- Changes under `src/core/` are also reviewed at the architecture level: responsibilities, interfaces, and state ownership of the modules they touch.

## Focuses

- For every code change, also review simplicity: duplicated mechanisms, needless abstraction layers, and special cases a shared path could absorb.

## Criteria

- Required: new runtime dependencies need a stated reason in the PR description.
- Preferred: user-facing error messages name the object and the next action.

## Emphasis

- When `src/auth/`, guards, or resource query conditions change, trace the whole path "login identity → tenant_id → database filter" first.
- When the refund event schema changes, check producers, consumers, and compatibility with stored messages; done means every existing consumer was checked.

## Business Constraints

- An order must have the payment platform's refund ID written before moving from `paid` to `refunded`; check every entry point and compensation job that changes this state.
- `tenant_id` comes from the login identity; retries and conflict recovery must never switch to the tenant field in the request payload.

## Performance Limits

- Bulk import handles at most 10,000 rows per call; when per-item database or remote calls change, check round trips and peak memory at that size.

## Known Issues

- Issue `Qiyin-Tech/payment-service#389` records the refund event compatibility decision; read it when that event changes.
- The project field "Scheduled" means planned only; only an explicit acceptance conclusion in the record proves a fix.

## Conventions

- `src/generated/` is generated from the schema; review schema and generated output for consistency without asking for direct edits to generated files.

## Project Context on Demand

- When order state transitions, compensation, or event compatibility in `src/orders/` change, read `.agents/skills/order-domain/SKILL.md` and use only its order states and event contracts.
```

## Lark Access

Central review has paused Lark evidence and judgment: no Lark CLI is prepared, no short-lived user access token (UAT) is injected, and Lark document, wiki, and base links only identify sources. Unread Lark material alone raises no warning or confirmation finding.

Lark support is kept for a future restore. After the maintainer authorizes through OAuth, the trusted renewal job still exchanges the refresh token hourly and saves new tokens to GitHub Environment secrets. Revoked authorization, an invalid refresh token, or a lost token from an interrupted rotation requires authorizing again.

A restore prepares the tools, injects the UAT, and verifies actual document permissions per [`central/lark-context.md`](central/lark-context.md). Readable material is bounded by the API scopes the app enabled and the user granted, intersected with the authorizing identity's document permissions. An identity in another tenant does not share the same UAT; cross-tenant material must be shared with the authorizing identity and verified.

Start authorization from `.env`, verify material, or switch apps or users per the [Lark operations guide](docs/lark-operations.md); production configuration and the renewal mechanism are in [Lark setup](docs/deploy-central-review.md#4-lark-user-oauth-and-automatic-renewal).

## Central Repository Configuration

Full deployment steps, app installation scope, and permissions are in the [deployment guide](docs/deploy-central-review.md). The following live in the central repository. App installation permissions and per-round token permissions are configured separately; see "Permission Boundaries" above.

Repository variables:

- `AGENTIC_REVIEW_PRODUCTION`: must be `true` to enable central review;
- `REVIEW_LANGUAGE`: required report language, `zh-CN` or `en`; controls model text, publisher text, and Check messages;
- `AGENTIC_REVIEW_CLIENT_ID`: Review App client ID;
- `REVIEW_AGENT_MODEL`: required model name; the workflow uses an OpenAI-compatible provider;
- `REVIEW_THINKING_LEVEL`: required reasoning level such as `xhigh`, shared by model calls and the publication footer; the review fails when unset;
- `REVIEW_AGENT_BASE_URL`: required OpenAI-compatible gateway URL;
- `AGENTIC_REVIEW_LARK_APP_ID`: Lark custom app ID;
- `AGENTIC_REVIEW_LARK_ROTATOR_CLIENT_ID`: client ID of the Lark Secret Rotator GitHub App installed only on the central repository.

Repository secrets:

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`: Review App private key;
- `REVIEW_AGENT_API_KEY`: model API key.

Long-lived Lark credentials live in the `lark-rotation` environment, and the UAT kept for a future restore lives in `lark-review`; names and commands are in the deployment guide.

## Maintenance

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

The tests check prompt assembly, recovery paths, skill links, example JSON, scope, workspace, submission, and publication. They do not test model behavior and do not prove the model investigates as written.
