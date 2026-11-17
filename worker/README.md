# Agentic Review Dispatcher Worker

The public webhook entry for central PR review. It only verifies signatures, filters, deduplicates, and triggers the central workflow in the control repository; **it runs no review and holds no model, target repository, or Lark credentials**.

The code is not bound to a GitHub organization, control repository, default branch, Cloudflare account, or domain. The same repository can run for different organizations through deployment configuration.

## Request Flow

1. Verify `X-Hub-Signature-256` and `X-GitHub-Event`.
2. Keep `opened`, `reopened`, `synchronize`, `ready_for_review`, and `converted_to_draft` on PRs in `ALLOWED_OWNER`, plus valid `@` mentions in new plain PR comments and inline thread comments.
3. Plain comments use `issue_comment.created` and inline threads `pull_request_review_comment.created`. Only comments on PRs are handled; edits never retrigger, and the bot's own comments and mentions in quotes or code never trigger.
4. Use `X-GitHub-Delivery` to locate a Durable Object and claim the delivery atomically; duplicate deliveries return `202`.
5. Sign a JWT with the Dispatcher GitHub App's client ID and PKCS#8 private key.
6. Get the Dispatcher App's installation token for the control repository owner.
7. Trigger `agentic-review.yml` at the `CONTROL_WORKFLOW_REF` version in `CONTROL_REPOSITORY`. This ref only locates the central workflow and has nothing to do with the target PR branch.

Comment webhooks provide no trustworthy PR base/head snapshot. The Worker passes the comment text, comment type, comment ID, thread root ID, and PR identity verbatim to the central workflow, which reads the PR's current base/head after entering that PR's concurrency queue. Automatic PR events still carry and verify the webhook snapshot. All `workflow_dispatch` inputs share GitHub's 65,535-character total limit; oversized requests fail explicitly without truncating the body. Do not rewrite that limit as a per-field or HTTP JSON UTF-8 byte limit; see [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs).

Scope decisions, earlier workspaces, review results, comment replies, and thread state are handled by the central workflow and the trusted publisher; the Worker holds no target repository, model, or publication credentials.

When workflow dispatch fails, the delivery claim is released so GitHub redelivery can retry. Successful claims are kept for seven days and then cleaned up by a Durable Object alarm.

## Configuration

Secrets:

| Secret | Use |
|---|---|
| `WEBHOOK_SECRET` | Verifies the Review App webhook HMAC |
| `DISPATCH_CLIENT_ID` | Dispatcher App JWT `iss` |
| `DISPATCH_PRIVATE_KEY_PKCS8` | Signs the Dispatcher App JWT |

Deployment vars:

| Variable | Example | Use |
|---|---|---|
| `CONTROL_REPOSITORY` | `example-org/agentic-review` | Repository hosting the central workflow |
| `CONTROL_WORKFLOW_REF` | `main` | Central workflow branch or tag chosen at deployment |
| `ALLOWED_OWNER` | `example-org` | Repository owner allowed into the review queue |
| `REVIEW_BOT_MENTION` | `@<actual-app-slug>` | Required; the GitHub mention form of the Review App's actual slug |

The Dispatcher App is installed only on the control repository with only `Actions: read and write`. Never add model, Review App, target repository, or Lark credentials to the Worker; the central workflow mints target repository installation tokens per task.

## Deployment Configuration

The repository's `wrangler.toml` is a copyable default. Put the actual Cloudflare account, Worker name, domain, and deployment vars in the Git-ignored `wrangler.local.toml`:

```toml
name = "my-agentic-review-dispatcher"
account_id = "<cloudflare-account-id>"
main = "worker/src/index.ts"
compatibility_date = "2026-08-17"
workers_dev = false
preview_urls = false
routes = [{ pattern = "review.example.com", custom_domain = true }]

[vars]
CONTROL_REPOSITORY = "example-org/agentic-review"
CONTROL_WORKFLOW_REF = "main"
ALLOWED_OWNER = "example-org"
REVIEW_BOT_MENTION = "@<actual-app-slug>"

[[durable_objects.bindings]]
name = "DELIVERIES"
class_name = "DeliveryDeduplicator"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DeliveryDeduplicator"]
```

Configure secrets and deploy:

```bash
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put WEBHOOK_SECRET
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_CLIENT_ID
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_PRIVATE_KEY_PKCS8
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml deploy
```

## Verification

```bash
pnpm check
pnpm test
pnpm dlx wrangler@4.123.0 deploy --dry-run
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml deploy --dry-run
```

`REVIEW_BOT_MENTION` must be configured explicitly and match the actual Review App slug. The central publisher derives the actual login `<actual-app-slug>[bot]` from the installation token's `app-slug`, so no separate `REVIEW_BOT_LOGIN` is needed; both point at the same app. Webhook signatures, event filtering, and delivery claims are covered by `test/webhook.test.ts`. The division of the three installation tokens is in [`../docs/deploy-central-review.md`](../docs/deploy-central-review.md).
