# Agentic Review Dispatcher Worker

中央 PR 审计的公开 webhook 入口。它只负责验签、过滤、去重和触发 `agentic-review` 中的中央 Workflow；**不执行 Review，也不持有模型、目标仓库或 Lark 凭证**。

## 请求流程

1. 验证 `X-Hub-Signature-256` 与 `X-GitHub-Event`。
2. 只接受 `Qiyin-Tech` 中非 draft PR 的 `opened`、`reopened`、`synchronize`、`ready_for_review`。
3. 用 `X-GitHub-Delivery` 定位 Durable Object，原子认领 delivery；重复投递直接返回 `202`。
4. 使用 Dispatcher GitHub App 的 Client ID 和 PKCS#8 私钥签发 JWT。
5. 获取该 App 在 `Qiyin-Tech` 的 installation token。
6. 触发 `Qiyin-Tech/agentic-review` 的 `central-review.yml@main`。

Workflow dispatch 失败时会释放 delivery claim，允许 GitHub redelivery 重试。成功 claim 保留七天，然后由 Durable Object alarm 清理。

## 权限边界

Dispatcher App 仅安装到 `Qiyin-Tech/agentic-review`，仅授予：

- Actions: read and write

Worker secrets：

| Secret | 用途 |
|---|---|
| `WEBHOOK_SECRET` | 验证 Review App webhook HMAC |
| `DISPATCH_CLIENT_ID` | Dispatcher App JWT `iss` |
| `DISPATCH_PRIVATE_KEY_PKCS8` | Dispatcher App JWT 签名 |

不要在 Worker 中加入模型、Review App、目标仓库或 Lark 凭证。新增外部上下文应由中央 Workflow 的可信 collector 获取并脱敏。

## 本地验证

从仓库根目录运行：

```bash
pnpm check
pnpm test
pnpm dlx wrangler@4.123.0 deploy --dry-run
```

Webhook 签名、事件过滤与 delivery claim 行为覆盖在 `test/webhook.test.ts`。

## 部署

部署到 `wrangler.toml` 指定的 `Root@qiyin.ink` Cloudflare account：

```bash
pnpm dlx wrangler@4.123.0 secret put WEBHOOK_SECRET
pnpm dlx wrangler@4.123.0 secret put DISPATCH_CLIENT_ID
pnpm dlx wrangler@4.123.0 secret put DISPATCH_PRIVATE_KEY_PKCS8
pnpm dlx wrangler@4.123.0 deploy
```

完整 GitHub App 配置见 [`../docs/deploy-central-review.md`](../docs/deploy-central-review.md)。
