# 中央 PR Review 协议

## 目标

下游仓库只安装 Review GitHub App。Review workflow、模型 key 和 App private key 全部留在中央仓库；目标仓库的维护者不能通过修改自己的 workflow 获取中央凭证。

## 事件链

```text
Review App pull_request webhook
  -> Cloudflare Worker
  -> 中央仓库 agentic-review.yml
  -> shaftoe/pi-coding-agent-action
  -> create_pull_request_review / reply_to_review_thread
```

Worker 只做四件事：验证签名、过滤非目标事件、按 delivery ID 去重、用 Dispatcher App 触发中央 workflow。它不执行目标代码，也不持有模型或 Review App 凭证。

接受的事件是非 draft PR 的 `opened`、`reopened`、`synchronize`、`ready_for_review`。workflow_dispatch 携带 `repository`、`repository_id`、`pull_number`、`base_sha` 和 `head_sha`，中央 workflow 会再次校验 PR 当前仍是同一个 open、非 draft 快照。

每轮始终生成 merge base 到当前 head 的完整 diff。若当前 PR 历史中存在由同一 Review App 完成且 `conclusion == success` 的 `Agentic Review / audit` Check Run，并且其 base SHA 与当前快照相同、对应 head 仍在当前提交历史中、此后没有 merge commit，则额外生成该 head 到当前 head 的净 diff 作为阅读重点；取消、失败和未完成的 Check 不形成 checkpoint。rebase、Update branch、其他非线性历史、base 变化或 Check Runs 查询失败会退回只提供完整 diff；查询失败会写入 workflow warning。两份 diff 相同时也只提供完整 diff，并标记全部变更均为增量。增量 diff 不缩小审查范围，也不能替代完整 diff 的 finding 证据和行号。

## 发布 Review 的权限方案

这是本项目最重要的权限边界。中央 workflow 用同一个 Review App 为当前目标仓库 mint 三个不同权限的 installation token：

```text
Review App private key（只在中央 Actions secret）
  ├─ Token A: 当前仓库，contents/pull_requests/actions/checks read
  │    -> checkout、GH_TOKEN、Pi bash 中的 gh
  ├─ Token B: 当前仓库，contents read、pull_requests write
  │    -> shaftoe action 的 github_token -> create_pull_request_review
  └─ Token C: 当前仓库，contents/pull_requests/checks write
       -> 隔离的可信 publish job：Check Run、thread 回复和 resolve/reopen
```

Token 默认约一小时过期，并且只允许当前目标仓库。Token A 通过 `GH_TOKEN` 进入 Agent shell，且密码学上没有写权限。`loaded_tools` 不加载 `create_pull_request` 或 `update_pull_request`，只加载两个受约束的 Review 出口。

这解决了 PR 中“能不能写 Review”的问题：不是使用长期 PAT，而是给不同发布 API 单独 mint 最小权限的 installation token。GitHub GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 实际还要求 `contents: write`，因此该权限只给不执行候选代码的隔离 publish job；Agent shell 始终只能看到 Token A。Action 内置的 `create_pull_request_review` 发布新 finding；自定义 `reply_to_review_thread` 只写入经过初步校验的请求，Pi 结束后由可信步骤重新校验当前 PR thread、发布详情并 resolve/reopen。任何发布失败仍会使 Review Check 失败。

## Agent 工具

中央 workflow 只加载：

- Pi 内置静态工具：`read`、`grep`、`find`、`ls`、`bash`；
- 只读 GitHub 工具：`get_ci_status`、`get_workflow_run_logs`；
- 发布工具：`create_pull_request_review`、`reply_to_review_thread`。

`GH_TOKEN` 是 Token A，所以 Agent 可以执行只读 `gh` 查询，但不能评论、合并、修改文件或 workflow。当前不提供 Lark/known issues 查询工具；后续接入飞书表格时再增加独立的只读工具。Agent 不得执行目标仓库脚本、安装依赖、测试、构建或任意外部请求。

## 可信输入

目标 PR 的源码、PR 描述、评论、`AGENTS.md` 和目标仓库规则都可能包含 prompt injection。中央 prompt 和 tool allowlist 位于中央 workflow/checkout 中，不由目标 PR 提供。目标文件只作为静态审查输入。Review 总结和 finding 使用中文；没有符合门槛的问题也必须发布 summary-only Review。
