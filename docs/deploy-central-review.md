# 部署中央 PR Review

## 1. Dispatcher App

在中央仓库所属 organization 创建 Dispatcher GitHub App：

- 关闭 webhook；
- 仅 `Actions: read and write`；
- 只安装到中央仓库。

Worker 使用它触发中央仓库的 `agentic-review.yml`，不使用它访问目标仓库。

## 2. Worker

Worker secrets：

- `WEBHOOK_SECRET`：Review App webhook HMAC secret；
- `DISPATCH_CLIENT_ID`：Dispatcher App Client ID；
- `DISPATCH_PRIVATE_KEY_PKCS8`：Dispatcher App 的 PKCS#8 private key。

Deployment vars：

- `CONTROL_REPOSITORY=owner/agentic-review`；
- `CONTROL_WORKFLOW_REF=main` 或固定 tag；
- `ALLOWED_OWNER=目标 owner`。

```bash
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put WEBHOOK_SECRET
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_CLIENT_ID
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_PRIVATE_KEY_PKCS8
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml deploy
```

## 3. Review App 与中央仓库

创建 Review GitHub App，开启 Pull request webhook，并安装到所有目标仓库以及中央仓库。App repository permissions 至少为：

- `Contents: read and write`（GitHub GraphQL 的 review thread resolve/unresolve 所需；只签发给隔离的可信 publish job）；
- `Pull requests: write`；
- `Actions: read`；
- `Checks: write`；
- `Metadata: read`（GitHub 默认权限）。

中央仓库 Actions variables：

- `AGENTIC_REVIEW_CLIENT_ID`：Review App Client ID；
- `REVIEW_AGENT_MODEL`：例如 `gpt-5.6-luna-2`；当前 workflow 使用 OpenAI-compatible provider；
- `REVIEW_AGENT_BASE_URL`：OpenAI-compatible gateway 地址。

中央仓库 Actions secrets：

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`：Review App private key；
- `REVIEW_AGENT_API_KEY`：模型 API key。

不要把上述 secrets 配到目标仓库。目标仓库不需要 `.github/workflows/review.yml`。

## 4. Review 发布权限验证

每次中央 workflow 会为当前 `owner/name` mint 三个 installation token：

| Token | 用途 | 权限 |
|---|---|---|
| read token | checkout、`GH_TOKEN`、Pi bash 的 `gh` | `contents: read`、`pull_requests: read`、`actions: read`、`checks: read` |
| review token（review job） | shaftoe action 的 `github_token` | `contents: read`、`pull_requests: write` |
| review token（publish job） | 隔离的可信 publish job | `contents: write`、`pull_requests: write`、`checks: write` |

publish job 的 `review token` 用于 Check Run 和 Pi 结束后的历史 thread 发布步骤。GitHub GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 除 `pull_requests: write` 外实际还要求 `contents: write`；该高权限 token 不进入 Agent shell，也不进入执行候选代码的 review job。自定义 `reply_to_review_thread` 扩展本身不读取 token，只写待发布请求；可信步骤重新校验请求属于当前 PR 的 root inline thread 后，才回复并 resolve/reopen。Check Run 的 `details_url` 指向当前 `${GITHUB_RUN_ID}`，因此 PR Checks 可以直接进入对应 Action。当前不提供 Lark/known issues 查询工具，后续接入飞书表格时再单独增加只读工具。

如果 Review 发布失败，先检查：

1. Review App 是否安装到目标仓库；
2. App 是否包含 `Pull requests: write` 和 `Contents: read and write`，且安装已接受最新权限；
3. Actions secret 中的 private key 是否属于该 App；
4. workflow 是否把 `github_token` 绑定到 `steps.review-token.outputs.token`，而不是只绑定只读 `GH_TOKEN`；
5. `GITHUB_REPOSITORY` 和 `pr_number` 是否指向 webhook 携带的目标 PR。

## 5. 验证

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm dlx wrangler@4.123.0 deploy --dry-run
```

用一个测试 PR 确认中央 workflow 日志中：Agent 的 `gh` 使用 read token，最后创建了一个 GitHub Pull Request Review，而不是普通 issue comment。
