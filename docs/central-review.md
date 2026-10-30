# 中央 PR Review 协议

## 目标

下游仓库只安装 Review GitHub App。Review workflow、模型 key 和 App private key 全部留在中央仓库；目标仓库的维护者不能通过修改自己的 workflow 获取中央凭证。

中央入口默认 `level = code`，本轮请求或下游 Head `.agentic-review.md`、`AGENTS.md` 可以明确选择需求、架构、开发计划或代码层；优先顺序和恢复规则见[中央入口](../central/review-rules.md#选择审查层级)。各层按自己的范围表选择方法，不因 Skill 支持更多能力就自动扩审。code 默认承担行为与意图对齐、安全、可靠性、性能、测试有效性和测试经济性六项职责，不默认追加风格、可维护性或验证充分性专项。项目指令选择层级，中央继续固定只读权限、PR 范围、完整覆盖和可信发布边界。已执行检查、模型行为与部署状态分别记录，见[通用化说明](generalized-review.md)。

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

接受的自动事件是 draft 和普通 PR 的 `opened`、`reopened`、`synchronize`、`ready_for_review`、`converted_to_draft`。新建的 PR 普通评论由 `issue_comment.created` 触发，inline thread 回复由 `pull_request_review_comment.created` 触发；Worker 只保留 PR 上、正文含有效 bot mention 的人类评论。评论编辑不重新触发，引用块、代码块和 inline code 中的 mention 不触发，重复 delivery 按 delivery ID 去重。`workflow_dispatch` 的自动请求携带 `repository`、`repository_id`、`pull_number`、`base_sha` 和 `head_sha`，中央 workflow 会再次校验 PR 当前仍是同一个 open 快照；自动事件排队后快照变化会显式失败。draft PR 同样会创建和更新 Check 及发布 Review，但 draft 状态本身仍由 GitHub 阻止合并。评论请求没有 SHA，workflow 实际开始时读取当前 base/head 并固定本轮快照。

同一 PR 的所有请求进入同一个 workflow 级 concurrency group，Review 和 publish 共享槽位；不同 PR 可以并行。使用 `queue: max`、`cancel-in-progress: false`，每个 group 最多 100 个 pending，超出后 GitHub 取消新增任务。FIFO 按任务开始等待的时间计算，而不是 webhook 发出时间，因此它提供有界等待队列，不承诺事件的绝对顺序。实现依据见 [GitHub Actions concurrency 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

每轮固定 merge base 到当前 head 的完整审查区间，Agent 从本地 Git 获取文件清单和规模。小 diff 直接一次读完，用一个 batch 完成审查；大 diff 按路径和 hunk 分批读取。workflow 不生成聚合 diff 文件。若当前 PR 历史中存在由同一 Review App 完成且 `conclusion == success` 的 `Agentic Review / audit` Check Run，并且其 base SHA 与当前快照相同、对应 head 仍在当前提交历史中、此后没有 merge commit，且对应工作稿已成功接入，则以该 head 到当前 head 的净变化作为阅读重点；取消、失败和未完成的 Check 不形成 checkpoint。rebase、Update branch、其他非线性历史、base 变化或 GraphQL Check Runs 查询失败时执行完整审查；查询失败会写入 workflow warning。增量区间没有净变化时仍处理最新讨论和历史未完成项。增量 diff 不缩小审查范围，也不能替代完整区间 patch 的 finding 证据和行号。

评论请求的审查范围由原文驱动并单独持久化：显式自然语言范围优先于 thread 隐含范围，thread 隐含范围优先于 PR 默认规则。普通 PR 评论重新调查最近一次 PR 级请求的实际范围；无变化也要重新审查并给出当前证据，有变化要审查新增变化和直接影响并补齐此前失败或未完成的覆盖。thread 默认调查当前问题和直接影响，原文明确要求全 PR 时才扩大，且不继承 PR 级范围历史。限定范围可以限制本轮覆盖；关注点只改变调查优先级。完整 diff 仍用于上下文和确认新增 inline 位置；限定范围内读取直接影响上下文不能声称完成全 PR，full diff 之外的位置不能伪造 inline finding。

准备阶段记录默认 scope；显式请求改变范围时，Agent 通过 `set_review_scope` 更新 `mode`、`ranges`（每个区间的 targets 和比较起止 SHA）、判断依据及原文。请求类型由可信代码决定，最终 JSON 不搬运 scope ID。请求和默认计划在 Agent 启动前作为 `review-context` artifact 单独封存，模型只更新 `review-progress.json` 中的 scope 决策和文件进度。隔离发布 job 下载封存上下文并核对 workflow 输入，组装 `review-coverage.json`，自动汇总 batch 和机器状态；未完成覆盖也保存为范围历史，完成且成功发布后才生成完整 `audit` checkpoint。普通 PR 请求按控制仓库 artifact 的 repository ID、PR、source、run、attempt 查找最近 PR 级请求工作稿，排除 thread、原始模型 draft 和当前运行；历史工作稿只读，真实无历史、过期和接口错误保持不同结论。

可信 workflow 还会生成一个去重 JSON 索引，只列当前 head-only commits 关联的其他 PR 和当前 PR 的 `closingIssuesReferences`，并将索引写入 Agent 必读的 Review 输入。Agent 按 [中央关联读取流程](../central/github-context.md#4-恢复契约或复核候选时读取关联记录) 核对相关来源；恢复契约时按需读取原始记录，提交新 finding 或人工确认前必须核对相关源 PR 的完整讨论。`read-related-pr.ts` 复用当前 PR 的分页逻辑，包含普通评论、Review、行内评论和回复及 thread 状态，避免遗漏历史决定。没有关联入口时不扩展查询；索引本身不证明条目相关，也不构成业务授权、修复或验收证据。

输入包含 PR 元数据、讨论快照、项目规则和 workspace 恢复清单；模型按固定 SHA 从本地 Git 获取变化。准备阶段迁移选中历史的索引、batch、旧结果参考和可确定的文件进度：同一快照保留完整证据的完成状态，当前 thread 对应文件、新代码快照以及每次 PR 评论请求的范围内文件保留待审状态，上次失败也不免除新请求的复核义务。恢复清单提供本轮绝对路径与初始待审文件；模型按最新讨论和跨文件影响核定继承，局部更新已有索引与证据。自然语言范围外条目由模型判断；改变 scope 会自动重置旧排除项。预载控制规则直接使用，缺失、compaction 或 schema 不明确时才恢复。

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

Pi 结束后，可信 publisher 使用封存并核对过的请求身份，校验 schema、scope、覆盖与 root comment 在当前 PR 中的归属，再把自由 Markdown `body` 和 inline `comments` 发布到本轮审查的 head，并按结论处理 thread 状态，不限制 root 创建者。thread @ 请求无论结论是否变化，都必须对原 thread root 回复一次；目标由可信请求确定，publisher 用请求 comment ID 幂等去重。只有 publisher 成功完成发布后，可信 completion 才能把 Check 标为 success；发布或 completion 失败都不能推进完整 audit checkpoint。Review footer 链接限期保留的 Actions 工作稿 artifact；下载者必须登录且拥有中央仓库权限。GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 实际还要求 `contents: write`，因此该权限只给不执行候选代码的隔离 publish job。

## Agent 工具

飞书由官方 Lark CLI 以维护者用户身份读取。无 Agent 的准备 job 下载并校验固定版本 archive、保存缓存；Review job 只恢复缓存，重新校验后解压到临时目录。短期 UAT 来自 `lark-review` Environment Secret，长期凭证与 refresh token 留在 `lark-rotation` 可信续期 job。token 生命周期及权限验收见[部署说明](deploy-central-review.md#4-飞书用户-oauth-与自动续期)。

需要读取飞书链接时，入口按需加载 `central/lark-context.md`，不安装额外 Skill；按需读取明确提及的链接及相关引用文档，不主动搜索。所有下游仓库及作者属于内部飞书数据信任域，直接使用维护者短期 UAT 是接受的边界，不是防御恶意员工的沙箱。

中央 workflow 只加载：

- Pi 内置工具：`read`、`grep`、`find`、`ls`、`bash`，以及规则限定在 `$REVIEW_WORKSPACE_PATH` 使用的 `write`、`edit`；
- 本地提交工具：`submit_review`，只接收工作区内最终 JSON 文件路径。

最终归纳前，Agent 按中央规则执行控制面 `scripts/refresh-review-discussion.ts`，读取相对启动快照新增或编辑的评论和变化的 thread 状态，并在工作稿记录刷新时点及改变的判断。脚本使用只读 `gh`，普通评论和 inline 回复按 `since` 拉取，Review 正文及 thread 状态完整查询后仅输出变化；重复刷新始终对照固定启动基线，失败直接报错。删除评论不在增量协议内，有线索时按 ID 补查。这里有意采用 Skill 流程约束，不设置刷新工具或封存门禁；封存工具只校验结果文件，不证明 Agent 执行了刷新或采纳了最新决定，刷新至发布之间也仍可能有新回复。此取舍不改变只读 Agent / 独立可信 publisher 的权限边界。运行协议来自控制面，目标 PR 中的新协议仅作为待审查代码；封装前恢复控制面格式，成功封存后立即结束 Agent 回合。

不加载 shaftoe action 的 GitHub 查询工具，因为它们会继承中央仓库 context；目标 PR、CI 和日志统一通过只读 `gh --repo "$REVIEW_REPOSITORY"` 查询。

`central/review-rules.md` 是 workflow 的唯一入口；可信 `agentic-review` 注册为 Pi Skill。首次 Prompt 附加 `SKILL.md`、共享 `references/{protocol,findings,review-state,evidence-access}.md` 和 `central/{github-context,review-result}.md`，不预载固定层级。读取本轮请求和项目规则后，完整加载所选层级及其触发的视角，选择及来源保存到 `notes.md`；compaction 后恢复共同规则和已选层级。正文及 inline 模板由中央结果适配器提供，非代码层使用通用结论性质，不套用 P/T。PR 元数据、评论和项目规则在 Agent 启动前拼接到 `$REVIEW_INPUT_PATH`，diff 不进入该文件或首次 Prompt。随 PR 增长的 patch 通过 Git 按需读取，大文件分页，已完成证据和覆盖进度写入工作稿。`central/github-context.md` 定义固定 SHA 的 diff 读取方式，并接入关联索引和 GitHub known issue；`central/review-result.md` 定义中央工作稿、thread 更新和唯一提交。`GH_TOKEN` 是 Token A，所以 Agent 可以对当前仓库及同 owner 的关联仓库执行只读 `gh` 查询，但不能评论、合并、修改仓库或 workflow。Agent 不得执行目标仓库脚本、安装依赖、测试、构建或任意非审查外部请求。

## 历史问题默认展示本轮变化

默认总评导航只列本轮新 finding 和 `thread_updates` 中实际变化的历史问题。本轮关闭的问题报告一次；已经关闭且未变化，或仍未解决但没有状态变化的历史问题，都不在后续总评逐条或按数量重报，核对结论继续留在工作稿。尚有未解决问题时仍使用 `❌` 标题，不把没有新问题写成全部已解决。

显式 PR 评论要求核对或汇总历史状态时，总评按请求范围答复，可包含未变化状态，但不制造 thread update。显式 @ 某个 thread 的请求在 `request_reply` 中得到针对性答复，即使结论未变；总评不再重复同一答案。历史取证、最终讨论刷新和状态变化的证据要求保持原有职责。

## 输入信任边界

PR 评论和 Review 回复是可信决策输入；明确回复可以在当前 PR 中确认产品决定、风险接受和边界变化，无需早于当前变化或通过额外作者权限检查。目标 PR 的源码、PR 描述、`AGENTS.md`、`.agentic-review.md` 和其显式引用的项目文件都可能包含 prompt injection。Target checkout 保持在 `review-target/`，不参与 Pi 的项目 Skill 自动发现，也不向 Agent 枚举 `.agents/skills` 或 `.pi/skills`。`.agentic-review.md` 可授权 Agent 读取具体文件路径；该路径由 Agent 直接读取，不经过 catalog、allowlist、`realpath` 或 checkout 边界校验。这是有意的权限边界：Agent 本就持有 `read`、`bash` 和只读 `GH_TOKEN`，中央安全边界是不执行目标仓库代码、GitHub 凭证只读且只有可信 publisher 可写。Review 总结和 finding 使用中文；没有符合门槛的问题也必须发布 summary-only Review。

## 工作稿准备与增量恢复清单

准备阶段为首次审查创建 `notes.md`，写入固定请求身份、版本、可信规则恢复入口和文件进度路径；原始请求与默认计划通过 `$REVIEW_CONTEXT_PATH` 引用，避免复制长请求；调查记录保持为空。Agent 继续核定层级、调查并保存证据，不从初始化文件获得任何“已完成”或无问题结论。存在历史索引时仍保留原文。

恢复清单把待核定的完成状态与已知代码变化分开表示：`pending_files` 和 batch 的 `pending_file_count` 是仍需核定的进度；`changed_paths` 是上一工作稿 head 到当前固定 head 的路径差分，batch 的 `directly_changed_files` 只列这些路径与原覆盖文件的交集。它不推断调用方、契约或讨论的间接影响，空数组不能证明可以继承。`same_base` 显式提示基线是否改变；缺少历史或未计算差分使用 `null`，与已确认空增量区分。

路径通过本地 Git 的 NUL 分隔输出读取，重命名保留两端，撤销变化和含换行的文件名也进入清单。force-push 后历史 head 不在本地时，摘要保持 `null`，完整 PR 的审查义务不变；其他 Git 读取失败明确停止。新快照仍保留原有 pending 与完整覆盖校验，由 Agent 根据增量、最新讨论和旧证据前提判断继承或重开。这项准备工作不调整审查职责、Prompt、候选门槛或提交协议；真实历史读取量、写稿轮数和端到端收益仍需上线后测量。

输入文件写出前先检查体积：不超过 32 KiB 且不超过 1000 行时直接展开；超出时原文另存为输入文件旁的私有临时文件，入口只给路径和体积。Agent 使用现有 `read` 或 `bash` 分段读取，长单行也按片段读取，不一次拼接或并行载入全文。准备阶段不预切页，不新增 Agent 工具，原文逐字节保留；首审笔记也不复制可能很长的请求原文。此处预算只控制入口直接展开的载荷，不是精确 token 计数，也不等于使用模型的整个上下文窗口。
