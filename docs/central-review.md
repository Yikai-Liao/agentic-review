# 中央 PR Review 协议

## 目标

下游仓库只安装 Review GitHub App。Review workflow、模型 key 和 App private key 全部留在中央仓库；目标仓库的维护者不能通过修改自己的 workflow 获取中央凭证。

中央入口默认 `level = code`，本轮请求或下游 Head `.agentic-review.md`、`AGENTS.md` 可以明确选择需求、架构、开发计划或代码层；优先顺序和恢复规则见[中央入口](../central/review-rules.md#选择审查层级)。各层按自己的范围表选择方法，不因 Skill 支持更多能力就自动扩审。code 默认承担行为与意图对齐、安全、可靠性、性能和测试有效性五项职责；测试审查默认仅执行 T1 失真，T2 过约束须本轮请求明确委托，测试经济性不参与中央审查，不默认追加风格、可维护性或验证充分性专项。项目指令选择层级，中央继续固定只读权限、PR 范围、完整覆盖和可信发布边界。已执行检查、模型行为与部署状态分别记录，见[通用化说明](generalized-review.md)。

## 事件链

```text
Review App `pull_request`、`issue_comment` 和 `pull_request_review_comment` webhook
  -> Cloudflare Worker
  -> 中央仓库 agentic-review.yml（自动请求合并）
  -> review-execution.yml（同 PR 审查与发布串行）
  -> prepare-review-context.ts（代码、历史、范围和输入的完整准备）
  -> shaftoe/pi-coding-agent-action（只读分析）
  -> 可信 agentic-review Skill + 中央 GitHub/结果适配器 + 持久化工作稿
  -> submit_review 接收结果对象，保存并封存最终 JSON
  -> publish-review-run.ts（可信校验、组装与发布）
  -> 归档一次工作区并完成 Check
```

Worker 只做四件事：验证签名、过滤非目标事件、按 delivery ID 去重、用 Dispatcher App 触发中央 workflow。它不执行目标代码，也不持有模型或 Review App 凭证。

接受的自动事件是 draft 和普通 PR 的 `opened`、`reopened`、`synchronize`、`ready_for_review`、`converted_to_draft`。新建的 PR 普通评论由 `issue_comment.created` 触发，inline thread 回复由 `pull_request_review_comment.created` 触发；Worker 只保留 PR 上、正文含有效 bot mention 的人类评论。评论编辑不重新触发，引用块、代码块和 inline code 中的 mention 不触发，重复 delivery 按 delivery ID 去重。`workflow_dispatch` 的自动请求携带 `repository`、`repository_id`、`pull_number`、`base_sha` 和 `head_sha`，中央 workflow 校验目标 PR 已打开或已合并，并核对固定快照；排队后快照变化仍显式失败。关闭但未合并的 PR 不接受审查。draft PR 同样会创建和更新 Check 及发布 Review，但 draft 状态本身仍由 GitHub 阻止合并。评论请求没有 SHA，workflow 实际开始时读取 PR 保存的 base/head 并固定本轮快照。

已合并的历史 PR 可通过手动派发或评论请求补审。代码仍按 PR 保存的 base/head SHA 获取，不依赖源分支名或源 fork 是否存在；审查原始 PR 快照，不替换为合并提交或目标分支最新版本。PR 状态、是否已合并和合并时间同时交付给 Agent。结果继续在原 PR 发布 Review、finding 和 thread 更新，Check 绑定原 head SHA。

同一 PR 的自动请求先在入口合并待处理候选，显式评论请求分别保留；进入执行层后，Review 和 publish 共享串行槽位，不同 PR 可以并行。两个并发层的具体行为见[自动请求合并与发布顺序](#自动请求合并与发布顺序)。

每轮固定 merge base 到当前 head 的完整审查区间。首次调查从 full 区间读取文件清单与 patch，小 diff 一次读完，大 diff 按路径和 hunk 分批读取。若当前 PR 历史中存在同一 Review App 成功完成的 `Agentic Review / audit`，base 相同且对应工作稿已接入，则从该 head 到当前 head 的增量区间开始调查。候选仅取当前 head 的祖先；普通合并和冲突解决保留基线，相关变化仍进入增量 diff。取消、失败、过期或不可恢复的记录不形成基线。完整覆盖由旧完成项与本轮调查共同构成，finding 的证据和行号仍绑定 full patch；workflow 不生成聚合 diff 文件。

评论请求的审查范围由原文驱动并单独持久化：显式自然语言范围优先于 thread 隐含范围，thread 隐含范围优先于 PR 默认规则。普通 PR 评论重新调查最近一次 PR 级请求的实际范围；无变化也要重新审查并给出当前证据，有变化要审查新增变化和直接影响并补齐此前失败或未完成的覆盖。thread 默认调查当前问题和直接影响，原文明确要求全 PR 时才扩大，且不继承 PR 级范围历史。限定范围可以限制本轮覆盖；关注点只改变调查优先级。完整 diff 仍用于上下文和确认新增 inline 位置；限定范围内读取直接影响上下文不能声称完成全 PR，full diff 之外的位置不能伪造 inline finding。

准备阶段记录默认 scope；显式请求改变范围时，Agent 通过 `set_review_scope` 更新 `mode`、`ranges`（每个区间的 targets 和比较起止 SHA）、判断依据及原文。请求类型由可信代码决定，最终 JSON 不搬运 scope ID。请求和默认计划在 Agent 启动前写入本地上下文，其 SHA-256 摘要由 Runner 保存为准备步骤输出；模型只更新 `review-progress.json` 中的 scope 决策和文件进度。Agent 结束后的发布步骤先按可信摘要校验同一份上下文内容，再核对 workflow 输入并组装 `review-coverage.json`；本地上下文变化或摘要缺失均阻断发布。未完成覆盖也保存为范围历史（含时间预算内发布的部分结论），完整覆盖且成功发布后才生成完整 `audit` checkpoint。普通 PR 请求按控制仓库 artifact 的 repository ID、PR、source、run、attempt 查找最近 PR 级请求工作稿，排除 thread、原始模型 draft 和当前运行；历史工作稿只读，真实无历史、过期和接口错误保持不同结论。

可信 workflow 还会生成一个去重 JSON 索引，只列当前 head-only commits 关联的其他 PR 和当前 PR 的 `closingIssuesReferences`，并将索引写入 Agent 必读的 Review 输入。Agent 按 [中央关联读取流程](../central/github-context.md#4-恢复契约或复核候选时读取关联记录) 核对相关来源；恢复契约时按需读取原始记录，提交新 finding 或人工确认前必须核对相关源 PR 的完整讨论。`read-related-pr.ts` 复用当前 PR 的分页逻辑，包含普通评论、Review、行内评论和回复及 thread 状态，避免遗漏历史决定。没有关联入口时不扩展查询；索引本身不证明条目相关，也不构成业务授权、修复或验收证据。

`prepare-review-context.ts` 统一负责代码、历史范围和输入的准备。PR 元数据复用快照解析时取得的原文，提交历史取自固定区间的本地 Git；讨论读取与 Git 下载并行，关联索引与 audit checkpoint 查询并行。Git 默认只获取固定 base/head 的历史；显式请求引用另一条历史中的旧范围时，按已验证记录补取缺失 SHA。历史制品由 GitHub CLI 下载、校验后以只读目录接入，不由 workflow 逐步传递恢复状态。

准备阶段迁移选中历史的工作稿、旧结果参考和文件进度：同一快照保留完成项；automatic 接入同 base 的可信完整 audit 后，未直接变化的完成项也默认延续，直接变化、新增和未完成项待审。当前 thread 及每次 PR 评论请求仍按请求复核。模型沿增量和最新讨论发现间接影响时重开相关完成项，局部更新已有证据。范围外条目由模型判断，改变 scope 会自动重置旧排除项。预载规则缺失、compaction 或 schema 不明确时才恢复。

## 发布 Review 的权限方案

这是本项目最重要的权限边界。中央 workflow 用同一个 Review App mint 三个不同权限和仓库范围的 installation token：

```text
Review App private key（只在中央 Actions secret）
  ├─ Token A: 目标 owner 中安装了 App 的仓库，contents/issues/pull_requests/actions/checks read
  │    -> checkout、shaftoe action、生成关联索引和 Pi 按编号读取关联记录
  ├─ Token B: 仅当前目标仓库，checks write
  │    -> Agent 启动前创建关联当前 Action Run 的 Check，不传给 Agent
  └─ Token C: 仅当前目标仓库，contents/pull_requests/checks write
       -> Agent 结束后的可信发布步骤：Review、完成 Check、thread 回复和 resolve/reopen
```

Token 默认约一小时过期。可信 workflow 在 Agent 启动前将 Token A 的可读集合固定为目标 owner 中安装了 Review App 的仓库，并且只授予读权限；目标 PR 不能增加仓库或权限。在这个固定集合内，workflow 关联索引或审查输入中的明确稳定 Issue/PR 引用可以选择尚未在 merge base 声明的私有记录供 Agent 按需读取，这是既定产品边界，不需要 merge-base 预授权。关联只建立查询入口，不证明候选相关性或业务授权。Token B 只供 Agent 启动前的可信 workflow step 使用；单个 installation token 不能读取其他 owner 的私有仓库。Agent 同时读取 merge base 和 PR head，按 head 理解预期合并后的语义。`loaded_tools` 不加载任何内置 GitHub 写工具；`write`/`edit` 只用于隔离 Review 工作区，`submit_review` 校验结果对象，自动保存工作稿副本并封存最终结果。

审查与发布共用一个 job 和 runner，按步骤区分 Agent 与可信发布。Agent 结束后才签发 Token C，且只通过步骤参数传给发布器和 Check completion；Agent 的 `GH_TOKEN` 与 Action input 仍绑定 Token A。准备入口从已按固定 `${{ github.sha }}` 检出的可信控制面工作树打包 `scripts` 与 `package.json`，将压缩包的 Base64 内容交给 Runner 保存为步骤输出。Agent 结束后，可信 workflow 启动器在全新临时目录恢复并执行该输出中的发布代码，省去第二次 checkout；不读取 Agent 可改写的本地脚本。请求上下文继续按准备步骤输出的 SHA-256 摘要校验。Runner 在准备步骤结束时保存输出，Agent 后续的输出属于自己的步骤，不能替换此前保存的代码或摘要。此处使用 GitHub 的[步骤输出机制](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#setting-an-output-parameter)，不是依靠 Agent 遵守本地文件只读权限。

`publish-review-run.ts` 统一验证、组装和发布。准备入口写出请求摘要后，即使后续输入装配失败，可信发布入口仍可组装可恢复范围；Agent 未成功完成时不发布 Review。组装成功后通过步骤输出登记 `workspace_ready`，后续发布失败或取消仍归档该范围。正常路径只归档一次：发布成功使用 `review-completed-workspace`，否则使用 `review-workspace`，包含已有的发布报告；归档失败仍使 Check 失败。原始诊断稿只供排查。目标代码只 checkout 一次，base 工作树共用 Git 对象，两个工作树创建时均禁用 checkout hook。

Pi 结束后，可信 publisher 使用封存并核对过的请求身份，校验 schema、scope、覆盖与 root comment 在当前 PR 中的归属，再把自由 Markdown `body` 和 inline `comments` 发布到本轮审查的 head，并按结论处理 thread 状态，不限制 root 创建者。thread @ 请求无论结论是否变化，都必须对原 thread root 回复一次；目标由可信请求确定，publisher 用请求 comment ID 幂等去重。只有 publisher 成功完成发布后，可信 completion 才能把 Check 标为 success；发布或 completion 失败都不能推进完整 audit checkpoint。Review footer 链接限期保留的 Actions 工作稿 artifact；下载者必须登录且拥有中央仓库权限。GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 实际还要求 `contents: write`，因此该权限只给 Agent 结束后的可信发布步骤。

### 时间预算与部分结论

`review-tools` 扩展在 `agent_start` 开始计时，预算由 workflow 的 `REVIEW_TIME_BUDGET_SECONDS`（540 秒）给出，Agent 不能自行宣布用尽。前 6 分钟为调查阶段：模型未提交就想结束时，扩展经 `agent_before_settle` 要求继续，`submit_review` 拒绝仍有 pending 的提交。第 6 分钟进入收尾阶段：通知模型停止新调查、刷新讨论并归纳已审部分，此后 `submit_review` 接受保留 pending 的部分结论。第 9 分钟起，`tool_call` 拦截除 `submit_review` 外的全部工具；此时仍不提交，只再提醒一次，之后 Agent 如实结束，发布器报告没有 `submit_review` 结果，Check 为 failure。Pi 步骤的 15 分钟超时只兜住卡死的工具调用。

部分结论由可信代码标示：发布器按 `review-progress.json` 的文件进度，在 Review 正文前加入已覆盖比例和全部未审查文件，不依赖模型自述。完整性只来自文件进度：存在未审查文件时 `complete_audit` 保持 false，不成为 audit checkpoint，Check 结论为 `action_required`（与 failure 同样阻止 required check，但表明结论已发布、只是覆盖不全），只有全部覆盖才是 success。评论请求会继承已发布部分的完成项：同一快照只审查剩余文件；有新提交时，base 不变且路径差分可读的前提下，只有直接变化的文件与原有未审文件需要审查，差分未知时整个范围重新待审。只回复 thread 的局部请求没有 Review 正文，未审查文件列在 thread 回复中。automatic 运行不继承部分结论的进度；评论请求续审的结论不会更新该提交的 `/audit` Check，它只由推送新提交或重新运行自动审查重新评定。

## Agent 工具

当前中央 Review 暂停飞书取证与判断，不下载或恢复 CLI archive、不安装 Lark CLI，也不读取 `lark-review` Environment 或注入 UAT。输入中的飞书文档、Wiki 和多维表格链接只作来源标识，不请求链接，也不因未读取资料新增缺证据告警或人工确认 finding。

授权和每小时 token 续期继续运行，长期凭证与 refresh token 仍留在 `lark-rotation`，UAT 继续保存到 `lark-review` 供以后恢复。`central/lark-context.md` 保留恢复后的读取规则；重新启用时须由可信入口恢复工具准备、完整性校验、UAT 注入及实际资料权限验收。token 生命周期和恢复步骤见[部署说明](deploy-central-review.md#4-飞书用户-oauth-与自动续期)。

中央 workflow 只加载：

- Pi 内置工具：`read`、`grep`、`find`、`ls`、`bash`，以及规则限定在 `$REVIEW_WORKSPACE_PATH` 使用的 `write`、`edit`；
- 本地提交工具：`submit_review`，直接接收正文、新 finding、历史 thread 更新和请求答复组成的结果对象；工具负责序列化、校验和持久化，Agent 不再先写文件、回读验格式。

最终归纳前，Agent 按中央规则执行控制面 `scripts/refresh-review-discussion.ts`，读取相对启动快照新增或编辑的评论和变化的 thread 状态，刷新时点保留在脚本输出中；有新判断时补入工作稿，已有记录充分时直接生成提交参数。脚本使用只读 `gh`，普通评论和 inline 回复按 `since` 拉取，Review 正文及 thread 状态完整查询后仅输出变化；重复刷新始终对照固定启动基线，失败直接报错。删除评论不在增量协议内，有线索时按 ID 补查。这里有意采用 Skill 流程约束，不设置刷新工具或封存门禁；封存工具只校验结果对象和覆盖状态，不证明 Agent 执行了刷新或采纳了最新决定，刷新至发布之间也仍可能有新回复。此取舍不改变只读 Agent / 独立可信 publisher 的权限边界。运行协议来自控制面，目标 PR 中的新协议仅作为待审查代码；封装前恢复控制面格式，成功封存后立即结束 Agent 回合。

不加载 shaftoe action 的 GitHub 查询工具，因为它们会继承中央仓库 context；目标 PR、CI 和日志统一通过只读 `gh --repo "$REVIEW_REPOSITORY"` 查询。

`central/review-rules.md` 是 workflow 的唯一规则入口；可信 `agentic-review` 注册为 Pi Skill。[Prompt 装配器](../scripts/load-review-prompt.ts)统一加载共同规则、中央适配器和默认 code 方法，包含完整测试方法。预载不改变层级选择与方法触发条件，其他所选规则按需读取；明确覆盖默认层级时将选择及来源保存到 `notes.md`，compaction 后据此恢复。正文及 inline 模板由中央结果适配器提供，非代码层使用通用结论性质，不套用 P/T。

PR 元数据、评论、项目规则、固定区间 patch 及工作稿进入 `$REVIEW_INPUT_PATH` 的材料索引，适合预算的原文随首次 Prompt 交付，其余通过路径按需读取。`central/github-context.md` 定义固定 SHA 的调查与恢复方式，并接入关联索引和 GitHub known issue；`central/review-result.md` 定义工作稿、thread 更新和唯一提交。`GH_TOKEN` 是 Token A，所以 Agent 可以对当前仓库及同 owner 的关联仓库执行只读 `gh` 查询，但不能评论、合并、修改仓库或 workflow。Agent 不得执行目标仓库脚本、安装依赖、测试、构建或任意非审查外部请求。

## 工作稿准备与增量恢复清单

中央只维护文件进度、一份工作稿和最终结果。`review-progress.json` 的每个 ledger 条目只有路径和状态；`notes.md` 保存调查中已取得、但公开结果未包含的支持证据、关键前提、排除理由与未完成缺口，没有 finding 也保留必要依据。按共同机制合写，与进度在同一次调用中保存；Thread、回复、Review 正文和最终结果已有的内容直接复用，不复制第二份，也不为交接另起补证或总结回合。通用 Skill 也使用单份工作稿，中央持久化格式由中央结果协议决定。

准备阶段为首次审查创建 `notes.md`，写入固定请求身份、版本、可信规则恢复入口和文件进度路径；原始请求与默认计划通过 `$REVIEW_CONTEXT_PATH` 引用，避免复制长请求。初始化索引由固定事实 JSON 块和空调查区组成，Agent 只补充必要的调查信息，不从初始化文件获得“已完成”或无问题结论。已有工作稿和上一轮结果参考迁移到本轮。

恢复清单的 `pending_files` 列出本轮待调查文件，已延续的完成项留在 `review-progress.json`；`changed_paths` 是上一工作稿 head 到当前固定 head 的路径差分，包含已从 full 清单消失的撤销路径。模型从这些变化和最新讨论出发追踪间接影响，按需重开旧完成项。`same_base` 提示基线是否改变；缺少历史或未知差分用 `null`，与已确认空增量区分。

路径通过本地 Git 的 NUL 分隔输出读取，重命名保留两端，撤销变化和含换行的文件名也进入清单。force-push 后历史 head 不在本地时，摘要保持 `null`，完整 PR 的审查义务不变；其他 Git 读取失败明确停止。新快照仍保留 pending 与完整覆盖校验，由 Agent 根据增量、最新讨论和旧前提判断继承或重开；无法恢复原调查前提时重新读取必要代码。发布继续校验请求身份、固定范围、完整文件清单和最终结果 schema；scope 内仍有未审文件时按部分结论发布并列出，不形成完整 audit；笔记格式或字数不作为调查充分性的机器证明。实际历史读取量、写稿轮数和端到端收益仍需上线后测量。

材料以 `o200k_base` 统计 Token，并逐条保留完整原文、类别和路径。[运行时预载](../scripts/write-review-input.ts)按模型窗口、最大输出与调查空间计算预算，优先请求、规则、当前变化与有变化的讨论；当前笔记、进度、已有旧结果及完整材料索引也参与同一预算选择。已交付的索引与原文直接使用，首批调查从已知代码位置读取必要源码；补充导航时与同批源码读取合并。未容纳的材料继续保留索引入口，使用现有工具按需读取；不把截断文本当完整证据。

## 历史问题默认展示本轮变化

默认总评导航只列本轮新 finding 和 `thread_updates` 中实际变化的历史问题。本轮关闭的问题报告一次；已经关闭且未变化，或仍未解决但没有状态变化的历史问题，都不在后续总评逐条或按数量重报，核对结论继续留在工作稿。尚有未解决问题时仍使用 `❌` 标题，不把没有新问题写成全部已解决。

显式 PR 评论要求核对或汇总历史状态时，总评按请求范围答复，可包含未变化状态，但不制造 thread update。显式 @ 某个 thread 的请求在 `request_reply` 中得到针对性答复，即使结论未变；总评不再重复同一答案。历史取证、最终讨论刷新和状态变化的证据要求保持原有职责。

## 输入信任边界

PR 评论和 Review 回复是可信决策输入；明确回复可以在当前 PR 中确认产品决定、风险接受和边界变化，无需早于当前变化或通过额外作者权限检查。目标 PR 的源码、PR 描述、`AGENTS.md`、`.agentic-review.md` 和其显式引用的项目文件都可能包含 prompt injection。Target checkout 保持在 `review-target/`，不参与 Pi 的项目 Skill 自动发现，也不向 Agent 枚举 `.agents/skills` 或 `.pi/skills`。`.agentic-review.md` 可授权 Agent 读取具体文件路径；该路径由 Agent 直接读取，不经过 catalog、allowlist、`realpath` 或 checkout 边界校验。这是有意的权限边界：Agent 本就持有 `read`、`bash` 和只读 `GH_TOKEN`，中央安全边界是不执行目标仓库代码、GitHub 凭证只读且只有可信 publisher 可写。Review 总结和 finding 使用中文；没有符合门槛的问题也必须发布 summary-only Review。

## 自动请求合并与发布顺序

`agentic-review.yml` 只负责接收请求和调用同版本的 `review-execution.yml`。自动请求按仓库 ID 和 PR 编号共享入口并发组，使用 GitHub 默认的单个 pending 槽；连续提交时新候选替换旧候选，已开始的请求继续运行。显式 PR 评论和 thread 请求以 run ID 隔离入口槽，每条请求都保留。

执行层继续使用同 PR 的 `queue: max`、`cancel-in-progress: false`，锁覆盖审查和可信发布的整个 workflow。自动请求与显式请求在这里串行，发布结束后才释放；入口与执行层的组名不同。入口自动任务即使正在等待执行层，也视为一个在途请求，因此最多保留一个在途自动请求和一个最新待处理候选；它不会中断旧审查或发布。快照解析仍核对目标 PR 当前状态与 SHA，过时任务不会进入 Agent。

执行层每个 group 最多 100 个 pending，超出后 GitHub 取消新增任务。FIFO 按开始等待该并发组的时间计算，而不是 webhook 发出时间；不承诺事件的绝对顺序。该上限不表示入口会保留全部自动请求。

这使用 GitHub 的[并发控制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)，无需由 Worker 列举、取消运行或维护另一份队列。显式请求的答复义务、只读 Agent token、独立发布 runner 与 token 均保持原边界。合并后的线上验收应覆盖连续 push、夹杂显式 @、旧轮正在发布和失败重试；本地结构测试不能替代 GitHub 的实际调度验收。
