# agentic-review

中央 PR Review 控制面。下游仓库只安装 GitHub App，不保存模型或 GitHub 凭证，也不需要 Review workflow。

## 运行链路

```text
GitHub pull_request webhook
  -> Cloudflare Worker（验签、过滤、去重）
  -> 中央仓库 workflow_dispatch
  -> 两个短期 installation token
       ├─ read：给 Pi 的 bash / gh
       └─ write：只给 shaftoe/pi-coding-agent-action 的 review tool
  -> Pi 读取目标 PR
  -> create_pull_request_review 发布 Review
```

中央 workflow 使用 [`shaftoe/pi-coding-agent-action`](https://github.com/shaftoe/pi-coding-agent-action)，不再维护自研 Pi SDK、multi-agent、aggregator、schema 或 benchmark。中央规则来自 `prompts/review-rules.md`；下游仓库的自定义规则放在 `.agentic-review.md`，用于补充中央规则。当前不接入 known issues 基线。

## 权限边界

每次任务用同一个 Review GitHub App 为当前目标仓库分别 mint 两个 installation token：

- **read token**：`contents: read`、`pull_requests: read`、`actions: read`、`checks: read`，通过 `GH_TOKEN` 给 Agent 的 `gh` 和 checkout 使用；
- **review token**：`contents: read`、`pull_requests: write`、`checks: write`，只在可信 workflow 的 Check Run 生命周期和 Action 的 `github_token` 中使用，不进入 Agent shell；Pi 只能通过 `create_pull_request_review` 发布 Review。

因此 Agent 即使被 PR 内容诱导执行 `gh pr comment`、`gh pr merge` 或写 API，也只有只读 token，GitHub 会拒绝写操作。
## 中央仓库配置

Repository variables：

- `AGENTIC_REVIEW_CLIENT_ID`：Review App Client ID；
- `REVIEW_AGENT_MODEL`：模型名称，必填；当前 workflow 使用 OpenAI-compatible provider；
- `REVIEW_AGENT_BASE_URL`：OpenAI-compatible gateway 地址，必填。

Repository secrets：

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`：Review App private key；
- `REVIEW_AGENT_API_KEY`：模型 API key。

Review App 必须安装到目标仓库，并拥有 `Contents: read`、`Pull requests: write`、`Checks: write`、`Actions: read`。Dispatcher App 只安装到中央仓库，拥有 `Actions: write`，由 Worker 使用。

## 本地检查

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

Worker 部署说明见 [`docs/deploy-central-review.md`](docs/deploy-central-review.md)。
