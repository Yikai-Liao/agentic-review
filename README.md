# agentic-review

中央 PR Review 控制面。下游仓库只安装 GitHub App，不保存模型或 GitHub 凭证，也不需要 Review workflow。

## 运行链路

```text
GitHub pull_request webhook
  -> Cloudflare Worker（验签、过滤、去重）
  -> 中央仓库 workflow_dispatch
  -> 三个短期 installation token
       ├─ read：给 Pi、Action 和只读 gh
       ├─ check：在 Pi 启动前创建关联 Check，不传给 Agent
       └─ publication：只给隔离的可信发布 job
  -> Pi 按中央 skills 审查，并在隔离工作区维护工作稿
  -> submit_review 封存最终 review-result.json
  -> 可信发布器创建一个完整 Review、更新历史 thread，并链接工作稿 artifact
```

中央 workflow 使用 [`shaftoe/pi-coding-agent-action`](https://github.com/shaftoe/pi-coding-agent-action)，不再维护自研 Pi SDK、multi-agent、aggregator 或 benchmark。`prompts/review-rules.md` 只负责阶段编排，运行时 skills 位于 `.github/pi-skills/`；下游仓库的自定义规则放在 `.agentic-review.md`，可以用自然语言补充项目特有的 known issue 来源、状态语义和关联 GitHub 仓库。Agent 先独立审查当前 diff，再按候选 finding 定向查询，不加载全量历史。

## 权限边界

每次任务用同一个 Review GitHub App mint 三个 installation token：

- **read token**：覆盖目标 owner 中安装了 Review App 的仓库，只有 `contents: read`、`issues: read`、`pull_requests: read`、`actions: read`、`checks: read`，给 checkout、Action 和 Agent 的只读 `gh` 使用；
- **check token**：只覆盖当前目标仓库且仅有 `checks: write`，在 Agent 启动前创建关联当前 Action Run 的 Check，不传给 Agent；
- **publication token**：只覆盖当前目标仓库，拥有 `contents: write`、`pull_requests: write`、`checks: write`，仅进入隔离的可信发布 job，用于创建 Review、完成 Check、thread 回复和 resolve/reopen。`contents: write` 是 GitHub GraphQL 执行 `resolveReviewThread`/`unresolveReviewThread` 的实际权限要求。

因此 Agent 即使被 PR 内容诱导执行 `gh pr comment`、`gh pr merge` 或写 API，也只有只读 token，GitHub 会拒绝写操作。

## 下游 known issue 说明

下游仓库可以直接在 `.agentic-review.md` 中用自然语言说明哪些缺陷、历史 Review、GitHub Issue、开发计划或外部记录属于 known issue，以及相关仓库地址和项目状态的含义；不要求固定 schema。例如可以说明“前后端跨仓库问题还需查询 `Qiyin-Tech/orchestra-frontend` 的 Issue 和 PR”。Review 按 PR head 理解预期合并后生效的项目语义；只有新增私有跨仓库读取范围仍要求 merge base 已有说明，避免当前 PR 自行扩大 Agent 的数据访问范围。

中央 `known-issues` skill 统一规定因果关联、状态证据和去重方式；GitHub 等来源 skill 只规定如何高效查询。Agent 先完成当前 diff 的独立分析，再按候选 finding 追溯 commit 来源 PR 或使用强关键词定向搜索，不会全量读取关联仓库。

## 中央仓库配置

Repository variables：

- `AGENTIC_REVIEW_CLIENT_ID`：Review App Client ID；
- `REVIEW_AGENT_MODEL`：模型名称，必填；当前 workflow 使用 OpenAI-compatible provider；
- `REVIEW_AGENT_BASE_URL`：OpenAI-compatible gateway 地址，必填。

Repository secrets：

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`：Review App private key；
- `REVIEW_AGENT_API_KEY`：模型 API key。

Review App 必须安装到目标仓库以及需要作为关联上下文读取的同 owner 仓库，并拥有 `Contents: read`、`Issues: read`、`Pull requests: write`、`Checks: write`、`Actions: read`。单个 installation token 不能跨 owner；其他 owner 的私有仓库不在当前读取范围。Dispatcher App 只安装到中央仓库，拥有 `Actions: write`，由 Worker 使用。

## 本地检查

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

Worker 部署说明见 [`docs/deploy-central-review.md`](docs/deploy-central-review.md)。
