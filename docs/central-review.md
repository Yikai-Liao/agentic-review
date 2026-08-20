# 中央 PR Review 协议

## 目标

下游仓库只安装 Review GitHub App。Review workflow、模型 key 和 App private key 全部留在中央仓库；目标仓库的维护者不能通过修改自己的 workflow 获取中央凭证。

## 事件链

```text
Review App pull_request webhook
  -> Cloudflare Worker
  -> 中央仓库 agentic-review.yml
  -> shaftoe/pi-coding-agent-action（只读分析）
  -> 中央 skills + 持久化工作稿
  -> submit_review 封存最终 JSON 文件
  -> 隔离的可信 publisher 创建 Review、更新 thread 并链接工作稿 artifact
```

Worker 只做四件事：验证签名、过滤非目标事件、按 delivery ID 去重、用 Dispatcher App 触发中央 workflow。它不执行目标代码，也不持有模型或 Review App 凭证。

接受的事件是非 draft PR 的 `opened`、`reopened`、`synchronize`、`ready_for_review`。workflow_dispatch 携带 `repository`、`repository_id`、`pull_number`、`base_sha` 和 `head_sha`，中央 workflow 会再次校验 PR 当前仍是同一个 open、非 draft 快照。

每轮始终生成 merge base 到当前 head 的完整 diff。若当前 PR 历史中存在由同一 Review App 完成且 `conclusion == success` 的 `Agentic Review / audit` Check Run，并且其 base SHA 与当前快照相同、对应 head 仍在当前提交历史中、此后没有 merge commit，则额外生成该 head 到当前 head 的净 diff 作为阅读重点；取消、失败和未完成的 Check 不形成 checkpoint。rebase、Update branch、其他非线性历史、base 变化或 Check Runs 查询失败会退回只提供完整 diff；查询失败会写入 workflow warning。两份 diff 相同时也只提供完整 diff，并标记全部变更均为增量。增量 diff 不缩小审查范围，也不能替代完整 diff 的 finding 证据和行号。

## 发布 Review 的权限方案

这是本项目最重要的权限边界。中央 workflow 用同一个 Review App 为当前目标仓库 mint 两个不同权限的 installation token：

```text
Review App private key（只在中央 Actions secret）
  ├─ Token A: 当前仓库，contents/pull_requests/actions/checks read
  │    -> checkout、shaftoe action、GH_TOKEN、Pi bash 中的 gh
  └─ Token B: 当前仓库，contents/pull_requests/checks write
       -> 隔离的可信 publish job：Review、Check Run、thread 回复和 resolve/reopen
```

Token 默认约一小时过期，并且只允许当前目标仓库。Token A 进入 Action 和 Agent shell，且密码学上没有写权限。`loaded_tools` 不加载任何内置 GitHub 写工具；`write` 只用于隔离 Review 工作区，`submit_review` 只封存该工作区内的最终 JSON 文件。

Pi 结束后，可信 publisher 将自由 Markdown `body` 和 inline `comments` 合并为一个 GitHub Review，再处理已有 thread 的状态变化。它会重新校验 schema、PR base/head 快照、root comment 和 bot 身份。Review footer 链接限期保留的 Actions 工作稿 artifact；下载者必须登录且拥有中央仓库权限。GitHub GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 实际还要求 `contents: write`，因此该权限只给不执行候选代码的隔离 publish job。任何发布失败仍会使 Review Check 失败。

## Agent 工具

中央 workflow 只加载：

- Pi 内置工具：`read`、`grep`、`find`、`ls`、`bash`，以及只允许规则使用在 `$REVIEW_WORKSPACE_PATH` 的 `write`；
- 本地提交工具：`submit_review`，只接收工作区内最终 JSON 文件路径。

不加载 shaftoe action 的 GitHub 查询工具，因为它们会继承中央仓库 context；目标 PR、CI 和日志统一通过只读 `gh --repo "$REVIEW_REPOSITORY"` 查询。

入口 prompt 只要求读取 `prompts/review-rules.md`；该文件按阶段引导 Agent 加载 `.github/pi-skills/` 中的上下文、证据、工作稿和提交规则，避免把完整规则作为一次性 prompt。`GH_TOKEN` 是 Token A，所以 Agent 可以执行只读 `gh` 查询，但不能评论、合并、修改仓库或 workflow。当前不提供 Lark/known issues 查询工具；后续可增加独立的只读 skill 和工具。Agent 不得执行目标仓库脚本、安装依赖、测试、构建或任意外部请求。

## 可信输入

目标 PR 的源码、PR 描述、评论、`AGENTS.md` 和目标仓库规则都可能包含 prompt injection。中央 prompt 和 tool allowlist 位于中央 workflow/checkout 中，不由目标 PR 提供。目标文件只作为静态审查输入。Review 总结和 finding 使用中文；没有符合门槛的问题也必须发布 summary-only Review。
