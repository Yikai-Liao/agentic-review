# agentic-review

中央 PR Review 控制面。下游仓库只安装 GitHub App，不保存模型或 GitHub 凭证，也不需要 Review workflow。

## 运行链路

```text
GitHub pull_request webhook
  -> Cloudflare Worker（验签、过滤、去重）
  -> 中央仓库 workflow_dispatch
  -> 两个短期 installation token
       ├─ read：给 Pi、Action 和只读 gh
       └─ publication：只给隔离的可信发布 job
  -> Pi 按中央 skills 审查，并在隔离工作区维护工作稿
  -> submit_review 封存最终 review-result.json
  -> 可信发布器创建一个完整 Review、更新历史 thread，并链接工作稿 artifact
```

中央 workflow 使用 [`shaftoe/pi-coding-agent-action`](https://github.com/shaftoe/pi-coding-agent-action)，不再维护自研 Pi SDK、multi-agent、aggregator 或 benchmark。`prompts/review-rules.md` 只负责阶段编排，运行时 skills 位于 `.github/pi-skills/`；下游仓库的自定义规则放在 `.agentic-review.md`，用于补充中央规则。当前不接入 known issues 基线。

## 权限边界

每次任务用同一个 Review GitHub App 为当前目标仓库分别 mint 两个 installation token：

- **read token**：`contents: read`、`pull_requests: read`、`actions: read`、`checks: read`，给 checkout、Action 和 Agent 的只读 `gh` 使用；
- **publication token**：`contents: write`、`pull_requests: write`、`checks: write`，仅进入隔离的可信发布 job，用于创建 Review、Check Run、thread 回复和 resolve/reopen。`contents: write` 是 GitHub GraphQL 执行 `resolveReviewThread`/`unresolveReviewThread` 的实际权限要求。

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
