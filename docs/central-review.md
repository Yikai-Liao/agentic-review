# 中央 PR Review 协议

## 目标

下游仓库只安装 Review GitHub App。Review workflow、模型 key 和 App private key 全部留在中央仓库；目标仓库的维护者不能通过修改自己的 workflow 获取中央凭证。

## 事件链

```text
Review App pull_request webhook
  -> Cloudflare Worker
  -> 中央仓库 agentic-review.yml
  -> shaftoe/pi-coding-agent-action（只读分析）
  -> 可信 agentic-review Skill + 中央 GitHub/结果适配器 + 持久化工作稿
  -> submit_review 封存最终 JSON 文件
  -> 隔离的可信 publisher 创建 Review、更新 thread 并链接工作稿 artifact
```

Worker 只做四件事：验证签名、过滤非目标事件、按 delivery ID 去重、用 Dispatcher App 触发中央 workflow。它不执行目标代码，也不持有模型或 Review App 凭证。

接受的事件是非 draft PR 的 `opened`、`reopened`、`synchronize`、`ready_for_review`。workflow_dispatch 携带 `repository`、`repository_id`、`pull_number`、`base_sha` 和 `head_sha`，中央 workflow 会再次校验 PR 当前仍是同一个 open、非 draft 快照。

每轮始终生成 merge base 到当前 head 的完整 diff。若当前 PR 历史中存在由同一 Review App 完成且 `conclusion == success` 的 `Agentic Review / audit` Check Run，并且其 base SHA 与当前快照相同、对应 head 仍在当前提交历史中、此后没有 merge commit，则额外生成该 head 到当前 head 的净 diff 作为阅读重点；取消、失败和未完成的 Check 不形成 checkpoint。rebase、Update branch、其他非线性历史、base 变化或 GraphQL Check Runs 查询失败会退回只提供完整 diff；查询失败会写入 workflow warning。两份 diff 相同时也只提供完整 diff，并标记全部变更均为增量。增量 diff 不缩小审查范围，也不能替代完整 diff 的 finding 证据和行号。

可信 workflow 还会生成一个去重 JSON 索引，只列当前 head-only commits 关联的其他 PR 和当前 PR 的 `closingIssuesReferences`。Agent 只有在代码与契约已经形成 finding 候选、且记录可能改变判断时才读取匹配对象；索引是按需读取入口，不证明条目与候选相关，也不构成业务授权、修复或验收证据。

增量入口直接展开 focus diff，并给出完整 diff 路径和由固定 base/head 生成的完整变更文件清单。模型根据增量影响和历史证据选择 full diff 的读取范围，也可选择完整读取；初审和全部变更均为增量时直接展开 full diff。上一轮 batch 由准备阶段复制到本轮工作区，模型只更新重开的证据，并在新索引记录继承来源和理由，后续 artifact 因而仍包含完整证据。

## 发布 Review 的权限方案

这是本项目最重要的权限边界。中央 workflow 用同一个 Review App mint 三个不同权限和仓库范围的 installation token：

```text
Review App private key（只在中央 Actions secret）
  ├─ Token A: 目标 owner 中安装了 App 的仓库，contents/issues/pull_requests/actions/checks read
  │    -> checkout、shaftoe action、生成关联索引和 Pi 按编号读取关联记录
  ├─ Token B: 仅当前目标仓库，checks write
  │    -> Agent 启动前创建关联当前 Action Run 的 Check，不传给 Agent
  └─ Token C: 仅当前目标仓库，contents/pull_requests/checks write
       -> 隔离的可信 publish job：Review、完成 Check、thread 回复和 resolve/reopen
```

Token 默认约一小时过期。可信 workflow 在 Agent 启动前将 Token A 的可读集合固定为目标 owner 中安装了 Review App 的仓库，并且只授予读权限；目标 PR 不能增加仓库或权限。在这个固定集合内，workflow 关联索引或审查输入中的明确稳定 Issue/PR 引用可以选择尚未在 merge base 声明的私有记录供 Agent 按需读取，这是既定产品边界，不需要 merge-base 预授权。关联只建立查询入口，不证明候选相关性或业务授权。Token B 只供 Agent 启动前的可信 workflow step 使用；单个 installation token 不能读取其他 owner 的私有仓库。Agent 同时读取 merge base 和 PR head，按 head 理解预期合并后的语义。`loaded_tools` 不加载任何内置 GitHub 写工具；`write`/`edit` 只用于隔离 Review 工作区，`submit_review` 检查 JSON 语法并封存该工作区内的最终结果。

同一 PR 的 Review workflow 串行执行。Pi 结束后，可信 publisher 将自由 Markdown `body` 和 inline `comments` 发布到本轮审查的 head，再处理已有 thread 的状态变化；即使期间出现新快照，旧结果仍先形成历史 thread，后续 Review 再根据新代码更新或关闭。Publisher 会重新校验 schema、root comment 和 bot 身份。Review footer 链接限期保留的 Actions 工作稿 artifact；下载者必须登录且拥有中央仓库权限。GitHub GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 实际还要求 `contents: write`，因此该权限只给不执行候选代码的隔离 publish job。任何发布失败仍会使 Review Check 失败。

## Agent 工具

中央 workflow 只加载：

- Pi 内置工具：`read`、`grep`、`find`、`ls`、`bash`，以及规则限定在 `$REVIEW_WORKSPACE_PATH` 使用的 `write`、`edit`；
- 本地只读工具：`refresh_review_threads`，在代码调查结束后获取目标 PR 最新 thread 状态和完整回复；GraphQL thread 与 REST comments 分别分页；
- 本地提交工具：`submit_review`，只接收工作区内最终 JSON 文件路径。

封存要求当前进程至少成功刷新一次讨论；刷新失败时不能封存。刷新时点和依据最新决定修正结论由审查规则约束，工具不判断自由文本是否遵循决定，也不保证刷新至 GitHub 发布之间不存在新回复。运行协议来自控制面，目标 PR 中的新协议仅作为待审查代码。

不加载 shaftoe action 的 GitHub 查询工具，因为它们会继承中央仓库 context；目标 PR、CI 和日志统一通过只读 `gh --repo "$REVIEW_REPOSITORY"` 查询。

`prompts/review-rules.md` 是 workflow 的唯一入口；可信 `agentic-review` 注册为 Pi Skill，其完整内容、必读 reference 和中央适配器同时附加到首次 Prompt，context compaction 后可通过 Skill 发现重新读取。PR、评论、项目规则和 diff 在 Agent 启动前拼接到 `$REVIEW_INPUT_PATH`；`central/github-context.md` 接入关联索引和 GitHub known issue，`central/review-result.md` 定义中央工作稿、thread 更新和唯一提交。`GH_TOKEN` 是 Token A，所以 Agent 可以对当前仓库及同 owner 的关联仓库执行只读 `gh` 查询，但不能评论、合并、修改仓库或 workflow。Agent 不得执行目标仓库脚本、安装依赖、测试、构建或任意非审查外部请求。

## 输入信任边界

PR 评论和 Review 回复是可信决策输入；明确回复可以在当前 PR 中确认产品决定、风险接受和边界变化，无需早于当前变化或通过额外作者权限检查。目标 PR 的源码、PR 描述、`AGENTS.md`、`.agentic-review.md` 和其显式引用的项目文件都可能包含 prompt injection。Target checkout 保持在 `review-target/`，不参与 Pi 的项目 Skill 自动发现，也不向 Agent 枚举 `.agents/skills` 或 `.pi/skills`。`.agentic-review.md` 可授权 Agent 读取具体文件路径；该路径由 Agent 直接读取，不经过 catalog、allowlist、`realpath` 或 checkout 边界校验。这是有意的权限边界：Agent 本就持有 `read`、`bash` 和只读 `GH_TOKEN`，中央安全边界是不执行目标仓库代码、GitHub 凭证只读且只有可信 publisher 可写。Review 总结和 finding 使用中文；没有符合门槛的问题也必须发布 summary-only Review。
