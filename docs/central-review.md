# 中央 PR Review 协议

## 目标

下游仓库只安装 Review GitHub App。Review workflow、模型 key 和 App private key 全部留在中央仓库；目标仓库的维护者不能通过修改自己的 workflow 获取中央凭证。

## 事件链

```text
Review App pull_request webhook
  -> Cloudflare Worker
  -> 中央仓库 agentic-review.yml
  -> shaftoe/pi-coding-agent-action
  -> create_pull_request_review
```

Worker 只做四件事：验证签名、过滤非目标事件、按 delivery ID 去重、用 Dispatcher App 触发中央 workflow。它不执行目标代码，也不持有模型或 Review App 凭证。

接受的事件是非 draft PR 的 `opened`、`reopened`、`synchronize`、`ready_for_review`。workflow_dispatch 携带 `repository`、`repository_id`、`pull_number`、`base_sha` 和 `head_sha`，中央 workflow 会再次校验 PR 当前仍是同一个 open、非 draft 快照。

## 发布 Review 的权限方案

这是本项目最重要的权限边界。中央 workflow 用同一个 Review App 为当前目标仓库 mint 两个不同权限的 installation token：

```text
Review App private key（只在中央 Actions secret）
  ├─ Token A: 当前仓库，contents/pull_requests/actions/checks read
  │    -> checkout、GH_TOKEN、Pi bash 中的 gh
  └─ Token B: 当前仓库，contents read、pull_requests write
       -> shaftoe action 的 github_token
          -> create_pull_request_review
```

Token 默认约一小时过期，并且只允许当前目标仓库。Token A 进入 Agent shell，但它密码学上没有写权限；Token B 不进入 shell，只由 shaftoe action 的 GitHub provider 创建 structured tool 使用。`loaded_tools` 不加载 `create_pull_request` 或 `update_pull_request`，只加载 `create_pull_request_review`。

这解决了 PR 中“能不能写 Review”的问题：不是依赖 prompt 约束，也不是使用长期 PAT，而是给发布 API 单独的 installation token 和 `pull_requests: write` 权限。`create_pull_request_review` 调用 GitHub `pulls.createReview`，可以同时提交 summary 和 diff 行上的 inline comments。

## Agent 工具

中央 workflow 只加载：

- Pi 内置静态工具：`read`、`grep`、`find`、`ls`、`bash`；
- 只读 GitHub 工具：`get_pr_diff`、`get_issue_or_pr_thread`、`get_ci_status`、`get_workflow_run_logs`；
- 发布工具：`create_pull_request_review`。

`GH_TOKEN` 是 Token A，所以 Agent 可以执行只读 `gh` 查询，但不能评论、合并、修改文件或 workflow。当前不提供 Lark/known issues 查询工具；后续接入飞书表格时再增加独立的只读工具。Agent 不得执行目标仓库脚本、安装依赖、测试、构建或任意外部请求。

## 可信输入

目标 PR 的源码、PR 描述、评论、`AGENTS.md` 和目标仓库规则都可能包含 prompt injection。中央 prompt 和 tool allowlist 位于中央 workflow/checkout 中，不由目标 PR 提供。目标文件只作为静态审查输入。Review 总结和 finding 使用中文；没有符合门槛的问题也必须发布 summary-only Review。
