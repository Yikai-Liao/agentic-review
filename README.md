# agentic-review

基于 Pi SDK 的公司内部多 Agent PR Review Engine，目标是提高真实问题召回率，同时保持低噪声。

## 运行方式

组织仓库通过 GitHub App webhook 触发本仓库的中央 GitHub Actions；下游无需复制 Workflow、保存密钥或遵循特定分支结构。中央任务先并发运行相互独立的 Reviewer session，再由 Aggregator 对全部 finding 做不可遗漏的同根因分组，最后由可信代码确定性渲染、由独立可信 Publisher 校验 LEFT/RIGHT diff 位置并发布一次总览 Review：无问题时给出 ✅ 说明，有问题时给出 ⚠️ 说明和行内评论。Reviewer 只有受路径约束的静态读取/搜索工具，不能执行 Shell、项目代码或网络请求，也不能读取模型、GitHub、Lark 或 Pi session 凭证。完整协议见 [`docs/central-review.md`](docs/central-review.md)。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
GITHUB_TOKEN=... pnpm benchmark:verify
REVIEW_AGENT_MODEL=... REVIEW_AGENT_API_KEY=... pnpm benchmark:run
```

`benchmark:verify` 只验证固定 v1 样本的 base/head 仍可获取且既有 expectation 位于 RIGHT-side diff，不调用模型。`benchmark:run` 顺序回放 sealed corpus，默认把报告写到 `.benchmark/report.json`；可用 `BENCHMARK_SAMPLE_IDS` 选择逗号分隔的样本。

运行时需要以下环境变量：

- `REVIEW_BASE_SHA`、`REVIEW_HEAD_SHA`、`REVIEW_PULL_NUMBER`
- `REVIEW_AGENT_MODEL`、`REVIEW_AGENT_API_KEY`
- 直接发布和中央 Publisher 均通过 `GH_TOKEN` 使用目标仓库 installation token
- 可选：`REVIEW_AGENT_BASE_URL`、`REVIEW_POLICY_ROOT`

中央 Engine 的 `.agentic-review.yml` 声明默认 Review Agents、概要 Agent、失败是否阻断以及仓库特定指令。目标仓库可在 base 分支放置同名文件完整覆盖默认配置，因此当前 PR 不能修改自己的审查范围。每个 Agent 必须对应中央 `prompts/<id>.md`；`overviewAgent` 必须被选中且为 `required: true`。仓库规则同样只从 base 快照的 `spec/review` 读取。

```yaml
overviewAgent: production-semantics
reviewAgents:
  - id: production-semantics
    required: true
    instructions: 仓库特定事实和审查重点
  - id: test-quality
    required: false
```

`required: false` 的 Agent 仍运行一次；失败时 Review 显示 ⚠️ 和不完整范围，但不使 required Check 失败。`instructions` 由目标仓库 base 分支维护者控制，属于可信审查策略输入；它不能增加工具或凭证权限，但可以改变该仓库的审查重点。

Darwin Skill 不作为运行时依赖。后续本地 prompt 演化会采用它的同一 judge 成对比较和退化回滚，并保留新增 fixture 后、修改规则后的两个人工确认门。
