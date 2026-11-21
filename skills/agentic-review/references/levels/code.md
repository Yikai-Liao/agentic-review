# Code Review: Correct Implementation and Verified Runtime and Maintenance Cost

Code review starts from real requirements and interface contracts and follows the implementation path to the actual outcome, applying focuses such as security, reliability, and performance through code-specific behavior and test methods.

## Fix the Code Scope and Grounds

A **delta** review fixes the complete change set per [local scope resolution](code/target-selection.md), which also defines the increment for a re-review; an **audit** fixes the current snapshot of an explicit module and compares current mechanisms with independent requirements.

Cover every file and every meaningful change in it, such as diff hunks or affected behavior, including both ends of deletions, renames, and copies and necessary connections that were left out. Unread parts of a large patch stay pending. [Test review](code/test-contracts.md) defines finer coverage for tests. Investigate from highest risk down: authentication and authorization, data writes and migrations, public contracts, concurrency and state, then tests, docs, and generated artifacts.

First recover the relevant business, API, data, security, diagnostic, and operational requirements from user goals, valid decisions, external contracts, and project rules; existing implementation, tests, and author summaries show the current state and help locate material.

Business confirmations follow the task's source rules. For code PRs with no other rule, an explicit decision on a specific business choice in a PR comment or review reply counts immediately as confirmation, regardless of its timing or the author's association. It covers only that business choice: system and host permissions keep their original authorization, and deploy commands in replies remain under review. Authorization for the current change needs a valid source other than ordinary descriptions, labels, or source declarations added by this change.

Before marking a unit complete, name the scenario most likely to break it — which input, ordering, caller, failure, or deployment order would make the new behavior deviate from its contract — and follow the code to the mechanism that blocks it or the consequence it causes. A unit touching several kinds of high-risk boundary gets at least one scenario per kind. If the scenario holds, continue under the finding bar; if it is blocked, record the scenario, the blocking mechanism, and its location. Mechanical changes such as versions, formatting, copy, and generated artifacts only note why no scenario is needed. Also record the behavior change users will observe after merge and whether the description, linked issues, or commit messages explain it.

## Choose Methods

An unrestricted full code review carries every default duty below without a separate request; each duty's trigger decides what it investigates.

### Default duties

| Duty | Method | Trigger in a full code review |
|---|---|---|
| Behavior and intent | [Intent alignment](../focuses/alignment.md) and [code behavior](code/behavior.md) | Every meaningful change and missing path, including returns, persistence, side effects, and error classes, diagnostics, or retry signals that change what consumers do or how they recover |
| Security boundaries | [Security](../focuses/security.md) | Adding, relaxing, or relying on authentication, authorization, tenant or resource ownership, or sensitive-data boundaries; a guard existing does not prove safety |
| Reliability and recovery | [Reliability](../focuses/reliability.md) | Changes to state, concurrency, transactions, side effects, retries, idempotency, cancellation, cleanup, or compensation |
| Performance and resource cost | [Performance](../focuses/performance.md) | Cost varies with collections, pagination, payloads, concurrency, locks, transactions, retries, or remote round trips; missing SLAs do not skip it, and complexity shapes or micro-optimization preferences are not evidence |
| Test validity | Wrong-acceptance and legitimate-change branches of [test review](code/test-contracts.md) | Test setup or assertions change, or a production change makes an existing wrong verdict reachable again |
| Test economics | Independent detection power and deletion proof in [test economics](code/test-economics.md) | New or changed test signals, per its branch table |

### Focuses with their own triggers

| Focus | Method | When |
|---|---|---|
| Maintainability | [Maintainability](../focuses/maintainability.md) | Explicit request, including project rules; requests about simplicity, structure, module responsibilities, or interfaces of the code under review land here |
| Verification sufficiency | [Verification](../focuses/verification.md) | Explicit audit, or independent verification is due now; missing tests alone do not trigger it |

Choosing code alone does not start an independent requirements, architecture, or plan review; read those artifacts only to recover code contracts. Architecture concerns raised about the code itself belong to the [architecture level](architecture.md) when it is also chosen for these changes; otherwise they are judged through maintainability (and reliability or performance where they apply) on the changed code. What stays a lead rather than a finding is listed in [code behavior](code/behavior.md#observations-that-stay-in-the-notes).

### Narrow, simplify, and harden requests

"Only performance", "only security", or "only test redundancy" narrow the investigation but still require the behavior contracts the judgment needs; state coverage by the focuses and dependencies actually used. `simplify` selects maintainability, plus test economics when tests would be deleted. `harden` selects reliability, test validity, and verification sufficiency. When a full code review is also requested, merge the chosen focuses into the default duties.

## Labels for Proven Impact

On top of the [shared finding kinds](../findings.md), code labels show impact or test failure mode:

| Label | Use when |
|---|---|
| **P0** | Proven realistic systemic or irreversible production consequence, such as cross-tenant access, unrecoverable data corruption, resource exhaustion, or dependency cascade; blocks the related release |
| **P1** | Reachable on common paths or at large scope, breaking key business, security, data, performance, or reliability behavior with no reliable workaround |
| **P2** | Proven ordinary production behavior or performance error, including diagnostic and recovery signals; narrow trigger or impact, or a reliable temporary workaround |
| **T1** | A test accepts an error it should reject — test distortion, a defect |
| **T2** | A test rejects a legitimate change (an overconstraint defect), or a strict deletion proof holds (an improvement with no added detection power); say which |
| **Confirmation needed** (`confirmation`) | A code-level decision: a real high-risk boundary changed, a necessary confirmation is missing now, and related sources were checked; the full `decision` bar still applies |

The label set is limited to these plus three shared kinds: a broken project rule or request criterion with no proven production consequence uses `defect`, maintainability and other improvements use `improvement`, and verification gaps use `verification-gap`. A broken rule that also has a proven production consequence takes the P label.

High-risk boundaries include authentication, isolation, ownership, sensitive data, deletion and migration, uniqueness, transactions, dates, money, state, idempotency, compensation, compatibility, and resource capacity. Proven production consequences take a P label; "confirmation needed" applies only when no consequence is proven but a necessary authorization or decision is genuinely missing now, never to cover a guess. One root cause's production, test, and confirmation problems are one finding.

A fix is confirmed when the original trigger behaves correctly and directly related legitimate behavior holds; performance problems keep the real scale, cost difference, and alternative evidence, and test problems keep their branch proof.
