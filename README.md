# agentic-review

基于 Pi SDK 的公司内部多 Agent PR Review Engine，目标是提高真实问题召回率，同时保持低噪声。

## 运行方式

组织仓库通过 GitHub App webhook 触发本仓库的中央 GitHub Actions；下游无需复制 Workflow、保存密钥或遵循特定分支结构。中央任务先并发运行相互独立的 Reviewer session，再由独立可信 Publisher 校验 RIGHT-side diff 位置并发布一次总览 Review：无问题时给出 ✅ 说明，有问题时给出 ⚠️ 说明和行内评论。Reviewer 只有受路径约束的静态读取/搜索工具，不能执行 Shell、项目代码或网络请求，也不能读取模型、GitHub、Lark 或 Pi session 凭证。完整协议见 [`docs/central-review.md`](docs/central-review.md)。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
GITHUB_TOKEN=... pnpm benchmark:verify
REVIEW_AGENT_MODEL=... REVIEW_AGENT_API_KEY=... pnpm benchmark:run
```

`benchmark:verify` 只验证固定样本的 base/head 仍可获取且 expectation 位于 RIGHT-side diff，不调用模型。`benchmark:run` 顺序回放 sealed corpus，默认把报告写到 `.benchmark/report.json`；可用 `BENCHMARK_SAMPLE_IDS` 选择逗号分隔的样本。

运行时需要以下环境变量：

- `REVIEW_BASE_SHA`、`REVIEW_HEAD_SHA`、`REVIEW_PULL_NUMBER`
- `REVIEW_AGENT_MODEL`、`REVIEW_AGENT_API_KEY`
- 直接发布模式需要 `GITHUB_TOKEN`、`GITHUB_REPOSITORY`；中央模式改由可信 Publisher 注入
- 可选：`REVIEW_AGENT_BASE_URL`、`REVIEW_POLICY_ROOT`、`REVIEW_AGENTS`

中央 Engine 通过 `review-agents.json` 声明可用和默认的 Review Agents；`REVIEW_AGENTS` 仅在运行时覆盖选择，不是模型配置。Prompt 按 Agent ID 从 `prompts/<id>.md` 加载，目标仓库无需配置。仓库规则默认只从 base 快照的 `spec/review` 读取。

Darwin Skill 不作为运行时依赖。后续本地 prompt 演化会采用它的同一 judge 成对比较和退化回滚，并保留新增 fixture 后、修改规则后的两个人工确认门。
