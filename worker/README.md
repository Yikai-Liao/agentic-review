# Agentic Review Dispatcher Worker

中央 PR 审计的公开 webhook 入口。它只负责验签、过滤、去重和触发控制仓库中的中央 Workflow；**不执行 Review，也不持有模型、目标仓库或 Lark 凭证**。

代码不绑定 GitHub organization、控制仓库、默认分支、Cloudflare account 或域名。同一份仓库可通过部署配置运行在不同组织。

## 请求流程

1. 验证 `X-Hub-Signature-256` 与 `X-GitHub-Event`。
2. 只接受 `ALLOWED_OWNER` 中非 draft PR 的 `opened`、`reopened`、`synchronize`、`ready_for_review`。
3. 用 `X-GitHub-Delivery` 定位 Durable Object，原子认领 delivery；重复投递直接返回 `202`。
4. 使用 Dispatcher GitHub App 的 Client ID 和 PKCS#8 私钥签发 JWT。
5. 获取 Dispatcher App 在控制仓库 owner 下的 installation token。
6. 查询控制仓库的默认分支，并触发该分支上的 `central-review.yml`。

Workflow dispatch 失败时会释放 delivery claim，允许 GitHub redelivery 重试。成功 claim 保留七天，然后由 Durable Object alarm 清理。

## 配置

Secrets：

| Secret | 用途 |
|---|---|
| `WEBHOOK_SECRET` | 验证 Review App webhook HMAC |
| `DISPATCH_CLIENT_ID` | Dispatcher App JWT `iss` |
| `DISPATCH_PRIVATE_KEY_PKCS8` | Dispatcher App JWT 签名 |

Deployment vars：

| Variable | 示例 | 用途 |
|---|---|---|
| `CONTROL_REPOSITORY` | `example-org/agentic-review` | 承载中央 Workflow 的仓库；默认分支从 GitHub API 获取 |
| `ALLOWED_OWNER` | `example-org` | 允许进入审计队列的仓库 owner |

Dispatcher App 只需安装到控制仓库，并仅授予 `Actions: read and write`。不要在 Worker 中加入模型、Review App、目标仓库或 Lark 凭证；外部上下文应由中央 Workflow 的可信 collector 获取并脱敏。

## 部署配置

仓库中的 `wrangler.toml` 是可复制的默认配置。具体 Cloudflare account、Worker 名称、域名和 deployment vars 应写入 gitignored 的 `wrangler.local.toml`：

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
ALLOWED_OWNER = "example-org"

[[durable_objects.bindings]]
name = "DELIVERIES"
class_name = "DeliveryDeduplicator"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DeliveryDeduplicator"]
```

配置 secrets 并部署：

```bash
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put WEBHOOK_SECRET
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_CLIENT_ID
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_PRIVATE_KEY_PKCS8
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml deploy
```

## 验证

```bash
pnpm check
pnpm test
pnpm dlx wrangler@4.123.0 deploy --dry-run
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml deploy --dry-run
```

Webhook 签名、事件过滤与 delivery claim 行为覆盖在 `test/webhook.test.ts`。完整 GitHub App 配置见 [`../docs/deploy-central-review.md`](../docs/deploy-central-review.md)。
