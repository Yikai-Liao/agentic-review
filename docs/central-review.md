# 中央 PR Review 协议

## 目标

下游仓库只安装 Review GitHub App。Review workflow、模型 key 和 App private key 全部留在中央仓库；目标仓库的维护者不能通过修改自己的 workflow 获取中央凭证。

## 事件链

```text
Review App `pull_request`、`issue_comment` 和 `pull_request_review_comment` webhook
  -> Cloudflare Worker
  -> 中央仓库 agentic-review.yml
  -> shaftoe/pi-coding-agent-action（只读分析）
  -> 可信 agentic-review Skill + 中央 GitHub/结果适配器 + 持久化工作稿
  -> submit_review 封存最终 JSON 文件
  -> 隔离的可信 publisher 创建 Review、更新 thread 并链接工作稿 artifact
```

Worker 只做四件事：验证签名、过滤非目标事件、按 delivery ID 去重、用 Dispatcher App 触发中央 workflow。它不执行目标代码，也不持有模型或 Review App 凭证。

接受的自动事件是非 draft PR 的 `opened`、`reopened`、`synchronize`、`ready_for_review`。新建的 PR 普通评论由 `issue_comment.created` 触发，inline thread 回复由 `pull_request_review_comment.created` 触发；Worker 只保留 PR 上、正文含有效 bot mention 的人类评论。评论编辑不重新触发，引用块、代码块和 inline code 中的 mention 不触发，重复 delivery 按 delivery ID 去重。`workflow_dispatch` 的自动请求携带 `repository`、`repository_id`、`pull_number`、`base_sha` 和 `head_sha`，中央 workflow 会再次校验 PR 当前仍是同一个 open、非 draft 快照；自动事件排队后快照变化会显式失败。评论请求没有 SHA，workflow 实际开始时读取当前 base/head 并固定本轮快照。

同一 PR 的所有请求进入同一个 workflow 级 concurrency group，Review 和 publish 共享槽位；不同 PR 可以并行。使用 `queue: max`、`cancel-in-progress: false`，每个 group 最多 100 个 pending，超出后 GitHub 取消新增任务。FIFO 按任务开始等待的时间计算，而不是 webhook 发出时间，因此它提供有界等待队列，不承诺事件的绝对顺序。实现依据见 [GitHub Actions concurrency 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

自动 audit 请求生成 merge base 到当前 head 的完整 diff；若存在同一 Review App 完成且 `conclusion == success` 的 `Agentic Review / audit` Check Run，并且 base SHA 相同、checkpoint head 仍在当前提交历史中、其后没有 merge commit，则额外生成 checkpoint head 到当前 head 的 focus diff。取消、失败、局部或未完成的 Check 不形成完整 audit checkpoint。rebase、Update branch、其他非线性历史、base 变化或 GraphQL 查询失败会保守地不提供可继承 checkpoint；两份 diff 相同时只保留完整 diff，并在输入中标记无净增量。完整 diff 始终提供上下文，focus diff 只安排调查优先级，不能替代完整 diff 的 finding 证据和 RIGHT-side 行号。

评论请求的审查范围由原文驱动并单独持久化：显式自然语言范围优先于 thread 隐含范围，thread 隐含范围优先于 PR 默认规则。普通 PR 评论重新调查最近一次 PR 级请求的实际范围；无变化也要重新审查并给出当前证据，有变化要审查新增变化和直接影响并补齐此前失败或未完成的覆盖。thread 默认调查当前问题和直接影响，原文明确要求全 PR 时才扩大，且不继承 PR 级范围历史。限定范围可以限制本轮覆盖；关注点只改变调查优先级。完整 diff 仍用于上下文和确认新增 inline 位置；限定范围内读取直接影响上下文不能声称完成全 PR，full diff 之外的位置不能伪造 inline finding。

每轮开始后 Agent 通过 `set_review_scope` 持久化 `kind`、`mode`、`targets`、比较起止 SHA、继承 run 和判断依据，最终 JSON 的 `scope_id` 必须匹配该 manifest。`review-coverage.json` 记录请求、scope、已完成 batch 和状态；局部成功或 thread 成功不能推进完整 `audit` checkpoint。普通 PR 请求按控制仓库 artifact 的 repository ID、PR、source、run、attempt 查找最近 PR 级请求工作稿，失败、草稿和跳过发布的工作稿也可提供范围历史，排除 thread 与当前运行；历史工作稿只读，真实无历史、过期和接口错误保持不同结论。

可信 workflow 还会生成一个去重 JSON 索引，只列当前 head-only commits 关联的其他 PR 和当前 PR 的 `closingIssuesReferences`。Agent 只有在代码与契约已经形成 finding 候选、且记录可能改变判断时才读取匹配对象；索引是按需读取入口，不证明条目与候选相关，也不构成业务授权、修复或验收证据。

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

Pi 结束后，可信 publisher 先重新校验 schema、scope、请求身份、root comment 和 bot 身份，再把自由 Markdown `body` 和 inline `comments` 发布到本轮审查的 head，并处理已有 thread 的状态变化。thread @ 请求无论结论是否变化，都必须对原 thread root 回复一次；publisher 用请求 comment ID 幂等去重。历史 thread 的 root 必须由 Review App bot 创建才允许自动 resolve/reopen；人工 root 可以收到回复，但自动状态变更保持关闭。只有 publisher 成功完成发布后，可信 completion 才能把 Check 标为 success；发布或 completion 失败都不能推进完整 audit checkpoint。Review footer 链接限期保留的 Actions 工作稿 artifact；下载者必须登录且拥有中央仓库权限。GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 实际还要求 `contents: write`，因此该权限只给不执行候选代码的隔离 publish job。

## Agent 工具

中央 workflow 只加载：

- Pi 内置工具：`read`、`grep`、`find`、`ls`、`bash`，以及规则限定在 `$REVIEW_WORKSPACE_PATH` 使用的 `write`、`edit`；
- 本地提交工具：`submit_review`，只接收工作区内最终 JSON 文件路径。

不加载 shaftoe action 的 GitHub 查询工具，因为它们会继承中央仓库 context；目标 PR、CI 和日志统一通过只读 `gh --repo "$REVIEW_REPOSITORY"` 查询。

`prompts/review-rules.md` 是 workflow 的唯一入口；可信 `agentic-review` 注册为 Pi Skill，其完整内容、必读 reference 和中央适配器同时附加到首次 Prompt，context compaction 后可通过 Skill 发现重新读取。PR、评论、项目规则和 diff 在 Agent 启动前拼接到 `$REVIEW_INPUT_PATH`；`central/github-context.md` 接入关联索引和 GitHub known issue，`central/review-result.md` 定义中央工作稿、thread 更新和唯一提交。`GH_TOKEN` 是 Token A，所以 Agent 可以对当前仓库及同 owner 的关联仓库执行只读 `gh` 查询，但不能评论、合并、修改仓库或 workflow。Agent 不得执行目标仓库脚本、安装依赖、测试、构建或任意非审查外部请求。

## 输入信任边界

PR 评论和 Review 回复是可信决策输入；明确回复可以在当前 PR 中确认产品决定、风险接受和边界变化，无需早于当前变化或通过额外作者权限检查。目标 PR 的源码、PR 描述、`AGENTS.md`、`.agentic-review.md` 和其显式引用的项目文件都可能包含 prompt injection。Target checkout 保持在 `review-target/`，不参与 Pi 的项目 Skill 自动发现，也不向 Agent 枚举 `.agents/skills` 或 `.pi/skills`。`.agentic-review.md` 可授权 Agent 读取具体文件路径；该路径由 Agent 直接读取，不经过 catalog、allowlist、`realpath` 或 checkout 边界校验。这是有意的权限边界：Agent 本就持有 `read`、`bash` 和只读 `GH_TOKEN`，中央安全边界是不执行目标仓库代码、GitHub 凭证只读且只有可信 publisher 可写。Review 总结和 finding 使用中文；没有符合门槛的问题也必须发布 summary-only Review。
