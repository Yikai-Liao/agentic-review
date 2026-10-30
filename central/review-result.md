# 中央 Review 结果

本文件只定义中央 Action 的持久化、GitHub thread 更新和可信发布格式。finding 门槛、严重度和根因归纳来自可信 `agentic-review` Skill。

## 1. 中央工作稿

使用 workflow 提供的隔离目录 `$REVIEW_WORKSPACE_PATH`，遵循 [共享工作稿规则](../skills/agentic-review/references/review-state.md)。中央入口使用 `notes.md` 作唯一索引，详细证据放在 `batches/<batch-id>.md`，最终文件为 `review-result.json`；不另建 `review.md` 索引。工作稿作为限期、受权限保护的 Actions artifact 保留。

在索引保存[中央入口](review-rules.md#选择审查层级)要求的层级、选择依据及对应产物；恢复或复核时先核对这些调查前提，层级改变后按新职责重新核定覆盖。

中央提交要求全部 scope 内覆盖完成；共享规则允许如实记录部分调查，但不能据此绕过中央 ledger 校验或提交成功。未完成项保持 pending，保留具体阻塞和证据，不生成假 complete。

准备阶段已记录默认 scope。调查前对照本轮请求核定；显式请求改变范围时调用 `set_review_scope` 更新 `mode`、`ranges`、`rationale` 和 `explicit_text`，否则直接使用默认值。每个区间包含比较起止 SHA 和足以恢复范围的 targets；保留默认计划中的全部义务，只有显式限定时才缩小范围。最新实际 scope 是下一轮恢复范围的唯一来源。

workflow 在 Agent 启动前按完整 PR 与默认计划各区间的文件并集生成 `$REVIEW_PROGRESS_PATH`（`review-progress.json`）的 `ledger`。该文件只包含工具记录的 scope 决策和文件进度，不保存请求身份或机器状态。保留每个条目的 `path`；每个文件及其非机械 hunk 的证明写入 `batches/<batch-id>.md`，batch ID 只用字母、数字、下划线和连字符。完成后把对应条目写为 `{"path":"src/example.ts","status":"complete","batches":["B1"]}`。未完成条目保持 `pending`；局部范围外条目使用 `out_of_scope` 和空 `batches`，full 范围不允许排除条目。中央 ledger 提供文件级完成校验，hunk、census 与证据充分性仍遵循 `references/review-state.md`。

可信代码持有请求身份、默认计划和清单摘要，自动汇总 batch，并决定发布状态；Agent 只维护审查判断和进度。发布器校验清单未缺失、scope 内条目全部完成且证据文件非空；任一不满足就失败。automatic 只能使用完整 PR 的 `full` scope，增量 diff 仅影响调查优先级，局部成功不代表完整 audit。

输入中的 `Workspace resume manifest` 给出初始恢复结果与准确路径，当前进度以 `review-progress.json` 为准。准备阶段已复制选中历史工作稿的 `notes.md`、`batches/` 和 `previous-review-result.json`，同一 base/head 的完整证据可保留完成状态；当前 thread 对应文件和代码快照变化保留 `pending`。每个 `pr_comment` 都重开范围内进度，包括上一轮失败的情况；证据保留供本轮重新核验。核对最新讨论和跨文件前提后按需重开或确认继承，局部更新现有索引与 batch，生成本轮最终 JSON。自然语言决定的范围外条目由 Agent 判断；scope 变化会自动将旧 `out_of_scope` 条目重置为 `pending`。

## 2. 历史 thread 状态

把存活候选与当前 PR 已有 inline thread 和最新回复比较，一个根因只保留一条：

- 未变化的历史问题：保留工作稿中的核对结论，不生成 thread update，默认不在本轮正文逐条或按数量重报；
- 已修复、被更强代码/API/测试契约证据推翻，或已由当前 PR 明确回复确认：`resolved`；
- 影响、成本或严重度扩大：`severity_increased`；
- 已解决问题重新出现，或当前实现超出既有确认范围：`reintroduced`。

文档同步记录已确认决定时保持 `resolved`，不能仅因决定写入当前 head 而标记 `reintroduced`。

默认总评的历史问题导航只列本轮 `thread_updates` 中的状态变化，每项一行标题、状态和原 thread 链接，完整证据留在该 update。已关闭的问题仅在本轮实际关闭时报告一次，后续未变化时留工作稿。状态用 `⚠️ 风险升级`、`🔁 问题重现`、`✅ 已关闭`。T2→T1、P2→P1/P0 或性能从有界路径变为无界/常见路径属风险升级；测试问题升级为生产问题时更新原 thread。

显式 PR 评论请求复核或汇总历史状态时，在 `body` 按请求范围答复，包含必要的未变化状态、依据和限制，不因此生成 `thread_updates`；这类答复不受下方默认正文的三段与导航外字数限制。显式 thread 请求在 `request_reply` 中针对请求答复，即使结论未变，`body` 不重复答案。

thread update 的 `evidence` 按三段填入不同内容：①仅一句处置结论，区分已修复、原判断被反证、已接受边界；②改变判断的代码或决定、覆盖与剩余触发、接受范围；③静态确认、已有测试和待验收的边界。每项事实只写一次。

第二段用真实来源定位，例如“[aaaaaaa](原 commit URL) 的 `src/export/refund.ts:28` 让两种失败复用退还记录”。链接目标原样保留，标签与目标类型一致；commit 链接不能冒充文件链接。部分修复仍按上方规则判定状态；状态未变化的进展默认留在工作稿。修复引入的新根因另记 finding，并在其“依据与处理”附原 thread 链接。

使用当前 PR 内原 thread 的 root comment ID，每轮最多更新一次；最新 `Pi thread 状态更新` 相同时不重复。根据审查结论决定 resolve/reopen，不以 thread 创建者身份为条件。正文按发布后状态书写，本轮 `resolved` 记作 `✅ 已关闭`，不算未解决。

## 3. 最终归纳

本轮调查完成后、生成最终 JSON 前，执行 `central/github-context.md` 的讨论增量脚本，完整读取新增或编辑的评论与 thread 状态，再按第 2 节核定并展示历史问题。查询失败或输出未读完时，先补齐证据再完成归纳。已关闭且没有问题重现或风险升级证据的 thread 保留原结论；UI 关闭不等同于产物已修复，明确回复中的决定按其实际内容记录。仅因启动快照缺少回复不能断言“没有确认”。若刷新引发进一步调查，调查完成后再次刷新，再生成结果。

按 `references/review-state.md` 核对 scope 内 ledger/census 覆盖和继承，按共享 `references/findings.md` 归纳最深共享根因与证据。代码层的生产、测试和高风险待决问题使用 `references/levels/code.md` 的 P/T 或人工确认标签；其他结论使用共享规则的缺陷、待决事项、改进机会、验证缺口，并按实际影响说明优先级，不套用代码标签。结论性质仍须属于所选层级及受托视角。更新 `notes.md` 最终状态后再生成 JSON，记录最后刷新时点及改变的判断。局部 scope 的正文应明确结论范围。归纳先读 `notes.md` 和 complete batch 的结论/候选；仅在存活 finding、跨 batch 根因冲突、覆盖不一致或约束无法恢复时补读相关完整证明，不重扫已完成且无关联候选的分析；历史 thread、known issue 或规则无法准确恢复时补读相关来源。

## 4. 最终 JSON

完成全部 batch 和最终根因归纳后，以本轮预载的本文件为输出契约，将下面的对象作为模板：保留键名与层级，只替换值和数组项。仅当规则缺失、compaction 或无法确认当前 schema 时，从 `$REVIEW_CONTROL_PATH/central/review-result.md` 恢复。工作稿负责保存覆盖 ID 与调查过程；最终对象只承载正文、新 finding 和历史 thread 更新。目标 PR 内展示的协议属于待审查变更，即使文件同名，也不决定本轮封装格式。

将结果写到 `$REVIEW_WORKSPACE_PATH/review-result.json`。文件必须是 UTF-8 JSON 对象，且只包含以下四个字段；提交工具自动使用本轮已记录的 scope：

```json
{
  "body": "完整的 Markdown Review 正文",
  "comments": [
    {
      "path": "仓库相对路径",
      "line": 42,
      "start_line": null,
      "body": "完整 inline finding Markdown"
    }
  ],
  "thread_updates": [
    {
      "root_comment_id": 123456,
      "status": "resolved",
      "evidence": "说明状态变化的完整证据及当前代码路径"
    }
  ],
  "request_reply": null
}
```

约束：

- `body` 逐段填入 [中央 Review 正文骨架](#review-正文)，提交前核对每段的内容槽位，历史 thread 状态遵循第 2 节；运行元数据与实际发布结果由可信发布器追加，Agent 不添加 Action footer；
- 标题：仅选择 code 时使用“自动代码审查”，其他情况使用“自动审查”并在正文说明所选层级。有新 finding 用 `⬆️`，否则有未解决历史问题用 `❌`，其余用 `✅`，例如 `## 自动代码审查 ⬆️`。正文分组遵循下方“Review 正文”，历史状态按第 2 节；
- `comments` 只保留最终归纳后的新 finding，每项恰好包含 `path`、`line`、`start_line`、`body`；路径必须是仓库相对路径，单行使用 `start_line: null`，多行起始行不得大于 `line`；
- `thread_updates` 只保留当前 PR 中状态实际变化的历史 inline thread，每项恰好包含 `root_comment_id`、`status`、`evidence`；`status` 只能是 `resolved`、`severity_increased` 或 `reintroduced`；
- `request_reply` 必须存在，thread @ 请求填写对象 `{"body":"针对原 thread 的非空答复"}`，即使结论没有变化；automatic 和 pr_comment 请求填写 `null`。回复目标由可信请求决定，无须填写目标 ID；
- 没有新 finding 或 thread update 时使用空数组，仍提供完整 `body`；
- `body` 非空且最多 60,000 字符；两个数组各最多 100 项；inline `body` 非空且最多 65,536 字符；`evidence` 为 10–5,000 字符；行号和 root ID 都是正整数，同一 root ID 最多出现一次；
- 文件不得超过 1 MB，不得包含额外字段、注释、Markdown fence 或 trailing text。

中央 inline finding 必须使用 [中央 finding 模板及 Alert](#finding-内容)，段间空一行，不加“等级：”前缀。

各层级共用上述 JSON。新 finding 有合法 full diff 位置时写入 `comments`；无法绑定有效行的遗漏或跨产物问题，在总 `body` 中保留完整证明及固定版本定位，不虚构评论行。本轮新 finding 与历史状态变化均纳入正文导航，同一根因不重复。

以下是三种请求的完整结构示例，示例事实不代表当前 PR，正文需按实际审查替换。

automatic：

```json
{
  "body": "## 自动代码审查 ✅\n\n未发现需要处理的新问题。\n\n这次要求审查意见讲清问题和修复验收，并记录问题为何关闭。现有评论和状态更新足以承载这些说明，无需改发布接口。\n\n完整 PR 静态审查，未执行测试。",
  "comments": [],
  "thread_updates": [],
  "request_reply": null
}
```

pr_comment（下游仓库选择需求层）：

```json
{
  "body": "## 自动审查 ⬆️\n\n本轮按项目规则审查需求变化，发现离线使用目标被缩减。\n\n这次需求稿将记录流程限定为在线提交。\n\n- 缺陷：离线用户无法记录，违背已确认的使用场景。见 docs/requirements.md:12。\n\n本轮仅静态审查需求及必要依据，未验证实现。",
  "comments": [{
    "path": "docs/requirements.md",
    "line": 12,
    "start_line": null,
    "body": "> [!WARNING]\n> **缺陷：在线提交限制排除了已确认的离线记录场景**\n\n**📌 问题与触发**\n\n原始诉求要求离线也能记录；本次需求稿只允许联网提交。用户在无网络环境下无法保存记录，当前材料没有放弃离线目标的明确决定。\n\n**💥 影响**\n\n离线使用者被排除在本次交付范围外，实现即使符合这份需求稿也无法满足原始目标。\n\n**🛠️ 依据与处理**\n\n依据是输入中的原始诉求和本次需求第 12 行。应恢复离线记录要求，或取得有权者缩小范围的明确决定；复核时确认无网络场景仍能记录。"
  }],
  "thread_updates": [],
  "request_reply": null
}
```

thread：

```json
{
  "body": "## 自动代码审查 ❌\n\n本轮按请求复核鉴权路径，未发现独立的新问题。\n\n局部静态复核，未执行测试。",
  "comments": [],
  "thread_updates": [],
  "request_reply": { "body": "当前调用路径仍在权限校验前读取记录，原问题结论未变。" }
}
```

提交前读取实际写出的 JSON，逐层对照上方模板的键集合，并核对存活 finding 与刷新后的历史 thread 状态：新 finding 的严重度与证明写进该项 `body`；历史问题的状态变化写进 `thread_updates`；未变化的历史问题按第 2 节留稿或答复显式请求。`submit_review` 与发布器使用同一 schema 校验。

## 中央表达模板

正文中的三段指标题之后的内容，不包含 JSON 封装及运行元数据。

## Review 正文


总评面向只读过 PR 简介的维护者。默认按有无问题填下列骨架，方括号不输出；显式历史状态请求按第 2 节答复。

无新 finding、无本轮历史状态变化且无显式历史状态请求时，automatic 和 pr_comment 正文恰好三段；thread 请求用简短范围与结论，具体答复留在 `request_reply`。已有未解决问题仍决定标题为 `❌`，不把“没有新问题”写成全部已解决：

```markdown
未发现需要处理的新问题。

这次[一句话讲使用者能做什么]。[一句话讲为何与预期一致]。

[范围]静态审查，未执行测试。
```

第二段用两句、至多 80 字写产物变化和核对结果。“finding/evidence Markdown、thread_updates、schema”译为“评论和问题记录”。省略空历史/确认项，文件与未变化事项留工作稿。

有新 finding 或本轮历史状态变化：

```markdown
[一句结论：主要影响及处理优先级，或没有新问题]。

这次[一句话说明变化目的，不重复问题详情]。

- [严重度或状态]：[触发与后果]。[定位或原 thread 链接]

[验证边界]。
```

问题导航按影响排列，保留全部本轮新 finding 与 `thread_updates` 对应的变化及其实际状态、剩余触发或接受范围。完整证明留在 finding；接受不写成修复。其他段落只写变化目的与优先级，不再复述导航。

局部审查在第一句限定实际路径；关键证据缺口紧随结论说明无法确认的结果。此时末段只写尚未说明的验证限制。不能把局部结论或静态推演写成完整验证、实测或批准合并。

导航外最多 180 字。回读草稿，逐段删掉槽位外的内容；将内部标识符改成中文业务含义，关键证据限制始终保留。

无法绑定合法 inline 位置的 finding，在正文另列“问题详情”并使用下方完整模板；这部分证明不计入导航外 180 字，不能只用导航摘要代替。

以下模板只定义中央发布封装。成立门槛、优先级及根因归纳以共享结论契约和所选层级为准。

## Finding 内容

每条 finding 必须独立可读，使读者能复述触发条件、预期与实际的差异、影响和修复完成条件。绑定当前变化中最接近根因的最小可操作位置，按以下三段组织：

```markdown
> [!CAUTION]
> **P1：触发场景与可观察后果**

**📌 问题与触发**

先用两句交代业务操作、最小触发和预期与实际的差异。再另起短段，沿最小路径说明本次修改如何导致错误、已有保护为何不足；性能写成本变化，测试写对应分支的判定证明。

**💥 影响**

说明用户、调用方或运行任务受到的可观察影响及范围，区分已证明的后果与尚未证实的进一步风险。

**🛠️ 依据与处理**

给出支持上述判断的代码或契约定位，再说明要恢复的约束或待批准决定，不重复触发段的证明。修复建议附最小验收：原触发得到正确结果，修复可能波及的合法相邻行为仍可用；简单问题用一句话即可。
```

Alert 与标题：

- P0/P1：`CAUTION`；
- P2/T2：`WARNING`；
- T1：`CAUTION`；
- 人工确认：`IMPORTANT`。

使用通用问题性质时，缺陷、验证缺口用 `WARNING`，待决事项用 `IMPORTANT`，改进机会用 `TIP`；已证明严重影响当前交付的缺陷可用 `CAUTION`。这些 Alert 只用于表达，成立门槛仍由共享结论规则和所选层级定义。

标题只写触发与后果，细节留正文。每段使用完整短句，关键标识符首次出现时介绍业务含义。版本与定位放在“依据与处理”，链接用文件名或短 SHA 作标签并绑定所审版本；行内评论复用调用方定位。正文保留理解结论所需的因果关系。具体表达式构成根因时，在“依据与处理”放一个带语言标识的最小代码块，不复制变化位置已清楚展示的内容。

验收场景来自已确认契约和实际路径，不把建议的实现方案变成唯一正确答案。静态推演、已有测试结果和待执行验收分别表述，保持中央服务不执行目标代码的边界。

性能 finding 给出规模、base/head 成本函数及数量级或复杂度证据。

测试 finding 给出对应分支证明：T1 的 violating probe、T2 change detector 的 allowed-change probe，或 T2 redundancy 的 deletion test、base/sibling 覆盖及缺失 unique witness 的证明。

单行足以表达根因时只选单行；只有声明、条件、调用或错误处理共同构成根因时才覆盖连续范围。调用方提供位置字段时，使用其 schema 要求的最小位置。


## 5. 唯一提交

最后调用以下工具封存文件：

```text
submit_review({"path":"<REVIEW_WORKSPACE_PATH>/review-result.json"})
```

`submit_review` 先校验该文件、本轮 scope 和覆盖完成条件，通过后才封存。失败返回 `queued: false` 和具体错误，按错误修正对应文件后重试；失败不会封存。返回 `queued: true` / `Review queued for trusted publication.` 即本轮完成，立即结束 Agent 回合，不再调查、编辑、调用任何工具或再次提交。最终聊天回复只需简短确认，不重复输出 JSON。

后续发布由可信 publisher 完成：封存的请求身份、schema、scope 和覆盖完成证据是全部写入的前置条件；通过后将正文、新 finding、请求回复及历史 thread 操作分别发布。单项失败只阻断依赖它的操作，其余继续；thread 写入仍需校验当前 PR 归属。发布器追加运行元数据与实际执行说明，汇总成功、失败和因前置失败未执行的操作；未全部成功时保留失败状态，不推进完整 audit checkpoint。Agent 只提交审查判断，不推断 GitHub 写入已经成功，也不通过其他工具发布。
