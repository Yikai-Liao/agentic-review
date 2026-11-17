# Repository Guide

## Repository Map

- `worker/`: webhook verification, filtering, deduplication, and dispatch; read the [deployment guide](docs/deploy-central-review.md) when deploying.
- `.github/workflows/agentic-review.yml` orchestrates central review; `scripts/` implements context preparation and trusted publication, `test/` covers that behavior, and the check commands are in `package.json`.
- `skills/agentic-review/` is the installable, general review method: a shared protocol, findings, workspace and re-review, report writing with examples, and requirements/architecture/plan/code levels. `central/` holds only central adapters: level selection and test branches, GitHub context, the workspace and result protocol, and the paused Lark rules. Behavior shared with local use belongs in the skill, not in `central/`.
- `.agentic-review.md` only adds this repository's review emphasis; `.agents/skills/writing-for-agents/` is for designing and auditing agent instructions.

## Implementation Constraints

Implement the complete review with maintainable, low-overhead code: fewer execution paths, states, abstractions, and dependencies, with one production path and one source of truth. Keep no legacy compatibility; extension points, defensive branches, limits, and degraded paths need an actual failure or explicit requirement behind them. Workflows only orchestrate; non-trivial validation and business logic live in testable code.

Fix shared root causes; never mask failures with warnings, skips, fallbacks, or success states. Remove or redefine features the platform truly does not support. Simplification must not remove security boundaries, input validation, data protection, or fail-closed behavior.

Scripts use TypeScript; migrate existing JavaScript scripts when changing them.

## Permissions and Trust Boundaries

- Verify the actual boundary before changing permissions. The central review agent shell's `GH_TOKEN` is always read-only; review results are written to GitHub only by the trusted workflow after the agent ends, using a separate least-privilege token. Publisher fixes must not widen agent token permissions. This does not restrict commits, pushes, or PRs from local maintenance sessions.
- Before the agent starts, the trusted workflow fixes the readable set to the target owner's repositories with the Review App installed; the target PR cannot widen it. Within that set, automatic association index entries or explicit stable issue/PR references in review input may select private records for on-demand read-only access without merge-base pre-authorization. A link is only a query entry and proves no business authorization, risk acceptance, fix, or acceptance.
- Explicit decisions in PR comments and review replies are trusted confirmation immediately; they need not predate the current change, and author identity, association, or extra permissions are not checked.
- Development, commits, and PRs target the public `Yikai-Liao/agentic-review`; `Qiyin-Tech/agentic-review` stays internal and only syncs the public `main` one way, with no independent commits or merged PRs on the organization side. Trusted maintainers review and release the control plane; the central workflow loads rules and tools from the control ref, and the target PR is static input only; target code is never run.
- Central review has paused Lark evidence and judgment: it prepares no Lark CLI and injects no Lark credentials for the agent. Authorization, scheduled token renewal, and the `central/lark-context.md` rules are kept. After a restore, downstream repositories and authors still count as one internal Lark data trust domain; the App Secret and single-use refresh token enter only the trusted renewal job, and executable caches must be pinned before the agent starts. Redesign this boundary before onboarding external repositories or contributors.

## Collaboration and Language

- When a maintainer questions a change, first explain motivation, necessity, impact, and alternatives; change it only after it is confirmed unnecessary or the maintainer explicitly asks to revert.
- Do not start subagents for code review during development; after a PR is opened, this repository's automatic review does the independent review.
- The user's task takes precedence over skill workflow guidance, while security and authorization boundaries still apply. Complete authorized local changes and read-only investigation directly; for unauthorized external writes or irreversible operations, prepare a reviewable result first and then ask for approval.
- Choose verification by affected behavior and risk; widen or rerun passing checks only for new changes, failures, or unresolved doubts.

AGENTS.md, skills, docs, code comments, commits, PRs, and issues (titles, bodies, comments, review summaries, and findings) are written in English. The central review's report language is configured separately by `REVIEW_LANGUAGE`.
