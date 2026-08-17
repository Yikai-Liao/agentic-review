# 中央 PR 审计协议

## 目标

组织内仓库只安装 GitHub App，不复制 Workflow、不保存 Agent/GitHub/Lark 密钥，也不要求特定分支名称或合并顺序。`agentic-review` 根据每次 PR 的 base/head SHA 审查并把 Check 与 Review 写回原 PR。

## 事件链

```text
GitHub Review App webhook
  -> Cloudflare Worker
  -> agentic-review workflow_dispatch
  -> 中央 GitHub Actions
  -> GitHub Review App Check + PR Review
```

Cloudflare Worker 只验签、用 Durable Object 原子认领 delivery ID、过滤事件并触发中央 Workflow；模型、Lark 和目标仓库凭证只存在于 `agentic-review` 的受保护环境。

### 接受的事件

仅处理 `pull_request` 的：

- `opened`
- `reopened`
- `synchronize`
- `ready_for_review`

忽略 draft PR。任务身份为：

```text
repository_id + pull_request_number + base_sha + head_sha
```

同一仓库、PR 和 head SHA 的重复任务会互相取消；不同 head 的任务可并行，但 Publisher 发布前会再次确认当前 PR head，旧任务不能向新版本写评论。所有检出、Check 和评论都绑定事件中的确切 base/head SHA；不读取或推断 `main`、`dev`、源分支类型及合并顺序。

## GitHub App 分权

使用两个 App，避免给所有业务仓库授予中央 Actions 写权限：

1. **Qiyin Agentic Review**
   - 安装到需要审查的仓库；
   - 订阅 Pull request 事件；
   - Metadata: read、Contents: read、Actions: read、Checks: write、Pull requests: write；
   - 中央 Workflow 用其 installation token 读取目标 PR、读取 CI 上下文并发布结果。
2. **Qiyin Agentic Review Dispatcher**
   - 只安装到 `Qiyin-Tech/agentic-review`；
   - Actions: write；
   - Cloudflare Worker 用它触发中央 Workflow。

## 合并门禁

目标仓库 Ruleset 要求指定 App 来源的 `Agentic Review / audit` Check。Check 尚未出现时 GitHub 保持 `Expected`，运行时为 `in_progress`，只有最新 head SHA 审查成功后才为 `success`；失败或 webhook/worker 故障均保持不可合并。

同时开启 `Require conversation resolution before merging`。Review 执行成功后 Check 可以通过，但每个 finding 必须是 inline review thread；未 Resolve 的 thread 继续阻止合并。

## 下游规则

Engine 默认只从 base SHA 的 `spec/review` 读取仓库规则，因此 PR 不能修改本次审查规则。后续可增加同样从 base SHA 读取的 `.agentic-review.json`，用于选择 Reviewer 和组织批准的上下文别名；配置不能直接提供 Token、API 地址或扩大 GitHub/Lark 权限。

## 可信边界

- 目标 PR 代码只作为静态数据读取，绝不执行测试、构建、依赖安装或项目代码。
- Reviewer 没有 Bash，只有限定在目标工作区和 Review context 内的静态 read/grep/find/ls 工具。
- GitHub/Lark 能力由可信采集器或窄化工具提供，不向 Reviewer 暴露真实 CLI 凭证。
- Review 与 Publisher 运行在不同 GitHub Actions job；Publisher 从受信任的 `main` 重新检出代码和目标 head，并重新校验 schema、文件大小、RIGHT-side diff 行及提交 SHA。
- `agentic-review` 自审时，只有可验证父提交的 synthetic merge commit 才能作为候选 Engine；不存在该 commit 时回退到受信任 Engine。候选 job 不能接触 Publisher token。
