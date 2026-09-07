# Agentic Review Dispatcher Worker

中央 PR 审计的公开 webhook 入口。它只负责验签、过滤、去重和触发控制仓库中的中央 Workflow；**不执行 Review，也不持有模型、目标仓库或 Lark 凭证**。

代码不绑定 GitHub organization、控制仓库、默认分支、Cloudflare account 或域名。同一份仓库可通过部署配置运行在不同组织。

## 请求流程

1. 验证 `X-Hub-Signature-256` 与 `X-GitHub-Event`。
2. 过滤 `ALLOWED_OWNER` 中非 draft PR 的 `opened`、`reopened`、`synchronize`、`ready_for_review`，以及新建的 PR 普通评论和 inline thread 评论中的有效 `@` 提及。
3. 普通评论使用 `issue_comment.created`，inline thread 使用 `pull_request_review_comment.created`。只处理 PR 上的评论；编辑评论不重新触发，机器人自己的评论、引用块和代码中的提及也不触发。
4. 用 `X-GitHub-Delivery` 定位 Durable Object，原子认领 delivery；重复投递直接返回 `202`。
5. 使用 Dispatcher GitHub App 的 Client ID 和 PKCS#8 私钥签发 JWT。
6. 获取 Dispatcher App 在控制仓库 owner 下的 installation token。
7. 触发 `CONTROL_REPOSITORY` 中 `CONTROL_WORKFLOW_REF` 指定版本的 `agentic-review.yml`。这个 ref 只定位中央 Action，与目标 PR 分支无关。

评论 webhook 不提供可供信任的 PR base/head 快照。Worker 将评论原文、评论类型、评论 ID、thread root ID 和 PR 标识原样传给中央 workflow；workflow 进入同一 PR 的并发队列后再读取当前 open、非 draft PR 的 base/head。普通自动 PR 事件仍携带并校验 webhook 快照。所有 `workflow_dispatch` inputs 受 GitHub 的 65,535 characters 总大小限制；超限请求明确失败，正文不截断。不要把该限制改写成单字段限制或 HTTP JSON UTF-8 字节限制，详见 [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs)。

Worker 只负责验签、过滤、去重和 dispatch。范围判断、历史工作稿、审查结果、评论回复与 thread 状态都由中央 workflow 和可信 publisher 处理；Worker 不持有目标仓库、模型或发布凭证。

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
| `CONTROL_REPOSITORY` | `example-org/agentic-review` | 承载中央 Action 的仓库 |
| `CONTROL_WORKFLOW_REF` | `main` | 部署时选定的中央 Action branch 或 tag |
| `ALLOWED_OWNER` | `example-org` | 允许进入审计队列的仓库 owner |
| `REVIEW_BOT_MENTION` | `@<actual-app-slug>` | 必填；填写 Review App 的实际 slug 对应的 GitHub 提及形式 |

Dispatcher App 只需安装到控制仓库，并仅授予 `Actions: read and write`。不要在 Worker 中加入模型、Review App、目标仓库或 Lark 凭证；目标仓库的 read/review installation token 由中央 Workflow 在每次任务中临时 mint。

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

`REVIEW_BOT_MENTION` 必须显式配置并与实际 Review App slug 对应。中央 publisher 从 installation token 的 `app-slug` 生成实际登录名 `<actual-app-slug>[bot]`，无需另设 `REVIEW_BOT_LOGIN`；两者指向同一个 App。Webhook 签名、事件过滤与 delivery claim 行为覆盖在 `test/webhook.test.ts`。三个 installation token 的权限分工见 [`../docs/deploy-central-review.md`](../docs/deploy-central-review.md)。
