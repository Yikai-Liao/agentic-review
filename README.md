# agentic-review

基于 Pi SDK 的公司内部多 Agent PR Review Engine，目标是提高真实问题召回率，同时保持低噪声。

## 运行方式

一个 GitHub Actions job 只安装一次 Pi：先并发运行相互独立且只读的 Reviewer session，再串行运行唯一拥有窄化 GitHub Review 工具的聚合发布 Agent。Reviewer 对审查结论负责但不能发布；聚合 Agent 直接信任 Reviewer，只合并明显重复项、排版并一次性发布，不做二次证据校验。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

运行时需要以下环境变量：

- `REVIEW_BASE_SHA`、`REVIEW_HEAD_SHA`、`REVIEW_PULL_NUMBER`
- `REVIEW_AGENT_MODEL`、`REVIEW_AGENT_API_KEY`
- `GITHUB_TOKEN`、`GITHUB_REPOSITORY`
- reusable workflow 调用方需显式传入只读 `AGENTIC_REVIEW_TOKEN`，用于检出私有 Engine 仓库
- 可选：`REVIEW_AGENT_BASE_URL`、`REVIEW_POLICY_ROOT`、`REVIEWERS`

仓库规则默认只从 base 快照的 `spec/review` 读取；通用审查方法来自当前固定版本的 Engine。

Darwin Skill 不作为运行时依赖。后续本地 prompt 演化会采用它的同一 judge 成对比较和退化回滚，并保留新增 fixture 后、修改规则后的两个人工确认门。
