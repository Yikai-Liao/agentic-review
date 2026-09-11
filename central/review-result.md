# 中央 Review 结果

本文件只定义中央 Action 的持久化、GitHub thread 更新和可信发布格式。finding 门槛、严重度和根因归纳来自可信 `agentic-review` Skill。

## 1. 中央工作稿

使用 workflow 提供的隔离目录 `$REVIEW_WORKSPACE_PATH`，遵循 `workspace.md`；工作稿作为限期、受权限保护的 Actions artifact 保留。

准备阶段已记录默认 scope。调查前对照本轮请求核定；显式请求改变范围时调用 `set_review_scope` 更新 `mode`、`ranges`、`rationale` 和 `explicit_text`，否则直接使用默认值。每个区间包含比较起止 SHA 和足以恢复范围的 targets；保留默认计划中的全部义务，只有显式限定时才缩小范围。最新实际 scope 是下一轮恢复范围的唯一来源。

workflow 在 Agent 启动前按完整 PR 与默认计划各区间的文件并集生成 `$REVIEW_PROGRESS_PATH`（`review-progress.json`）的 `ledger`。该文件只包含工具记录的 scope 决策和文件进度，不保存请求身份或机器状态。保留每个条目的 `path`；每个文件及其非机械 hunk 的证明写入 `batches/<batch-id>.md`，batch ID 只用字母、数字、下划线和连字符。完成后把对应条目写为 `{"path":"src/example.ts","status":"complete","batches":["B1"]}`。未完成条目保持 `pending`；局部范围外条目使用 `out_of_scope` 和空 `batches`，full 范围不允许排除条目。中央 ledger 提供文件级完成校验，hunk、census 与证据充分性仍遵循 `workspace.md`。

可信代码持有请求身份、默认计划和清单摘要，自动汇总 batch，并决定发布状态；Agent 只维护审查判断和进度。发布器校验清单未缺失、scope 内条目全部完成且证据文件非空；任一不满足就失败。automatic 只能使用完整 PR 的 `full` scope，增量 diff 仅影响调查优先级，局部成功不代表完整 audit。

输入中的 `Workspace resume manifest` 给出初始恢复结果与准确路径，当前进度以 `review-progress.json` 为准。准备阶段已复制选中历史工作稿的 `notes.md`、`batches/` 和 `previous-review-result.json`，同一 base/head 的完整证据可保留完成状态；当前 thread 对应文件和代码快照变化保留 `pending`。每个 `pr_comment` 都重开范围内进度，包括上一轮失败的情况；证据保留供本轮重新核验。核对最新讨论和跨文件前提后按需重开或确认继承，局部更新现有索引与 batch，生成本轮最终 JSON。自然语言决定的范围外条目由 Agent 判断；scope 变化会自动将旧 `out_of_scope` 条目重置为 `pending`。

## 2. 历史 thread 状态

把存活候选与当前 PR 已有 inline thread 和最新回复比较，一个根因只保留一条：

- 未变化且未解决：不生成 thread update，正文列为 `⏳ 仍未解决`；
- 已修复、被更强代码/API/测试契约证据推翻，或已由当前 PR 明确回复确认：`resolved`；
- 影响、成本或严重度扩大：`severity_increased`；
- 已解决问题重新出现，或当前实现超出既有确认范围：`reintroduced`。

文档同步记录已确认决定时保持 `resolved`，不能仅因决定写入当前 head 而标记 `reintroduced`。

正文每个历史 thread 列一行状态、finding 标题和链接，必要时简述部分修复的进展；状态用 `⏳ 仍未解决`、`⚠️ 风险升级`、`🔁 问题重现`、`✅ 已关闭`，完整状态变化证据写入 thread update。T2→T1、P2→P1/P0 或性能从有界路径变为无界/常见路径属风险升级；测试问题升级为生产问题时更新原 thread。

thread update 的 `evidence` 说明哪项修复或决定改变了原判断，并关联具体 SHA、代码路径或明确回复。关闭原因区分“已修复”“原判断被反证推翻”和“已接受边界”；修复说明覆盖了哪些触发场景，接受决定说明适用范围。部分修复说明已消除与剩余的触发条件，按上方规则判定状态；仍未解决且没有状态变化时，有请求回复就在回复中展开，否则在正文该条状态行简述进展。修复引入的新根因另记 finding 并关联原 thread，保留先后关系。静态确认、已有测试结果与尚未完成的验收分别表述。

使用当前 PR 内原 thread 的 root comment ID，每轮最多更新一次；最新 `Pi thread 状态更新` 相同时不重复。根据审查结论决定 resolve/reopen，不以 thread 创建者身份为条件。正文按发布后状态书写，本轮 `resolved` 记作 `✅ 已关闭`，不算未解决。

## 3. 最终归纳

代码调查完成后、生成最终 JSON 前，执行 `central/github-context.md` 的讨论增量脚本，完整读取新增或编辑的评论与 thread 状态，再按第 2 节核定历史问题。查询失败或输出未读完时，先补齐证据再完成归纳。已关闭且没有问题重现或风险升级证据的 thread 按 `✅ 已关闭` 表达；UI 关闭不等同于代码已修复，明确回复中的决定按其实际内容记录。仅因启动快照缺少回复不能断言“没有确认”。若刷新引发进一步代码调查，调查完成后再次刷新，再生成结果。

按 `workspace.md` 核对 scope 内 ledger/census 覆盖和继承，按 `findings.md` 归纳最深共享根因、严重度与证据；更新 `notes.md` 最终状态后再生成 JSON，记录最后刷新时点及改变的判断。局部 scope 的正文应明确结论范围。batch 重读条件遵循 `workspace.md`；历史 thread、known issue 或规则无法准确恢复时补读相关来源。

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

- `body` 按 [findings.md 的 Review 正文规则](../skills/agentic-review/references/findings.md#review-正文)组织，历史 thread 状态遵循第 2 节；运行元数据与实际发布结果由可信发布器追加，Agent 不添加 Action footer；
- 标题：有新 finding 或人工确认用 `## 自动代码审查 ⬆️`，否则有未解决历史问题用 `## 自动代码审查 ❌`，其余用 `## 自动代码审查 ✅`。正文分组遵循 `findings.md`，历史状态按第 2 节；
- `comments` 只保留最终归纳后的新 finding，每项恰好包含 `path`、`line`、`start_line`、`body`；路径必须是仓库相对路径，单行使用 `start_line: null`，多行起始行不得大于 `line`；
- `thread_updates` 只保留当前 PR 中状态实际变化的历史 inline thread，每项恰好包含 `root_comment_id`、`status`、`evidence`；`status` 只能是 `resolved`、`severity_increased` 或 `reintroduced`；
- `request_reply` 必须存在，thread @ 请求填写对象 `{"body":"针对原 thread 的非空答复"}`，即使结论没有变化；automatic 和 pr_comment 请求填写 `null`。回复目标由可信请求决定，无须填写目标 ID；
- 没有新 finding 或 thread update 时使用空数组，仍提供完整 `body`；
- `body` 非空且最多 60,000 字符；两个数组各最多 100 项；inline `body` 非空且最多 65,536 字符；`evidence` 为 10–5,000 字符；行号和 root ID 都是正整数，同一 root ID 最多出现一次；
- 文件不得超过 1 MB，不得包含额外字段、注释、Markdown fence 或 trailing text。

中央 inline finding 必须使用 [findings.md 的模板、Alert 和证明要求](../skills/agentic-review/references/findings.md#finding-内容)，段间空一行，不加“等级：”前缀。

以下是三种请求没有新 finding 或 thread 状态变化时的完整结构示例，示例事实不代表当前 PR，正文需按实际审查替换。

automatic：

```json
{
  "body": "## 自动代码审查 ✅\n\n未发现需要处理的新问题。\n\n这次主要调整审查意见的写法：讲清问题怎么发生、怎样修、怎样验收；后续回复还要说明问题是修好了、原判断不成立，还是接受了某项边界。核对结果：这些说明能由现有评论和状态更新承载，不需要改发布接口或增加权限。\n\n已静态审查完整 PR；未执行测试。",
  "comments": [],
  "thread_updates": [],
  "request_reply": null
}
```

pr_comment：

```json
{
  "body": "## 自动代码审查 ✅\n\n本轮仅按请求复核鉴权链路，未发现新问题；不代表完整 PR 的审查结论。\n\n新增读取入口仍先核对当前用户的资源权限，拒绝请求时不会返回资源内容。以上为静态判断，未执行测试。",
  "comments": [],
  "thread_updates": [],
  "request_reply": null
}
```

thread：

```json
{
  "body": "## 自动代码审查 ❌\n\n原问题仍未解决：当前路径仍在权限校验前读取记录。本轮仅静态复核该 thread 涉及的鉴权路径。\n\n⏳ 仍未解决：[缺少权限校验](https://github.com/owner/repo/pull/7#discussion_r123456)",
  "comments": [],
  "thread_updates": [],
  "request_reply": { "body": "当前调用路径仍在权限校验前读取记录，原问题结论未变。" }
}
```

提交前读取实际写出的 JSON，逐层对照上方模板的键集合，并核对存活 finding 与刷新后的历史 thread 状态：新 finding 的严重度与证明写进该项 `body`；历史问题的状态变化写进 `thread_updates`；未变化的历史问题只在总 `body` 中关联。`submit_review` 与发布器使用同一 schema 校验。

## 5. 唯一提交

最后调用以下工具封存文件：

```text
submit_review({"path":"<REVIEW_WORKSPACE_PATH>/review-result.json"})
```

`submit_review` 先校验该文件、本轮 scope 和覆盖完成条件，通过后才封存。失败返回 `queued: false` 和具体错误，按错误修正对应文件后重试；失败不会封存。返回 `queued: true` / `Review queued for trusted publication.` 即本轮完成，立即结束 Agent 回合，不再调查、编辑、调用任何工具或再次提交。最终聊天回复只需简短确认，不重复输出 JSON。

后续发布由可信 publisher 完成：封存的请求身份、schema、scope 和覆盖完成证据是全部写入的前置条件；通过后将正文、新 finding、请求回复及历史 thread 操作分别发布。单项失败只阻断依赖它的操作，其余继续；thread 写入仍需校验当前 PR 归属。发布器追加运行元数据与实际执行说明，汇总成功、失败和因前置失败未执行的操作；未全部成功时保留失败状态，不推进完整 audit checkpoint。Agent 只提交审查判断，不推断 GitHub 写入已经成功，也不通过其他工具发布。
