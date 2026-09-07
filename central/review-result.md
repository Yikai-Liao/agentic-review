# 中央 Review 结果

本文件只定义中央 Action 的持久化、GitHub thread 更新和可信发布格式。finding 门槛、严重度和根因归纳来自可信 `agentic-review` Skill。

## 1. 中央工作稿

使用 workflow 提供的隔离目录 `$REVIEW_WORKSPACE_PATH`，遵循 `workspace.md`；工作稿作为限期、受权限保护的 Actions artifact 保留。

准备阶段已将上一轮 `batches/` 复制到本轮可写目录。根据历史索引判定继承或重开；本轮重新生成 `notes.md` 和最终 JSON，记录有效 batch 及来源，历史文件存在本身不构成本轮覆盖证明。

## 2. 历史 thread 状态

把存活候选与当前 PR 已有 inline thread 和最新回复比较，一个根因只保留一条：

- 未变化且未解决：不生成 thread update，正文列为 `⏳ 仍未解决`；
- 已修复、被更强代码/API/测试契约证据推翻，或已由当前 PR 明确回复确认：`resolved`；
- 影响、成本或严重度扩大：`severity_increased`；
- 已解决问题重新出现，或当前实现超出既有确认范围：`reintroduced`。

文档同步记录已确认决定时保持 `resolved`，不能仅因决定写入当前 head 而标记 `reintroduced`。

正文每个历史 thread 只列一行状态、finding 标题和链接；状态用 `⏳ 仍未解决`、`⚠️ 风险升级`、`🔁 问题重现`、`✅ 已关闭`，完整证据只写入 thread update。T2→T1、P2→P1/P0 或性能从有界路径变为无界/常见路径属风险升级；测试问题升级为生产问题时更新原 thread。

使用原 thread 的 root comment ID，每轮最多更新一次；最新 `Pi thread 状态更新` 相同时不重复。publisher 负责回复和 resolve/reopen；正文按发布后状态书写，本轮 `resolved` 记作 `✅ 已关闭`，不算未解决。

## 3. 最终归纳

代码调查完成后调用 `refresh_review_threads`，读取最新状态和完整回复，再按第 2 节核定历史问题。已关闭且没有问题重现或风险升级证据的 thread 按 `✅ 已关闭` 表达；UI 关闭不等同于代码已修复，明确回复中的决定按其实际内容记录。仅因启动快照缺少回复不能断言“没有确认”。若刷新引发进一步代码调查，调查完成后再次刷新，再生成结果。

按 `workspace.md` 核对 ledger/census 覆盖和继承，按 `findings.md` 归纳最深共享根因、严重度与证据；更新 `notes.md` 最终状态后再生成 JSON，记录最后刷新时点及改变的判断。batch 重读条件遵循 `workspace.md`；历史 thread、known issue 或规则无法准确恢复时补读相关来源。

## 4. 最终 JSON

完成全部 batch 和最终根因归纳后，将文件写到 `$REVIEW_WORKSPACE_PATH/review-result.json`。文件必须是 UTF-8 JSON 对象，且只包含以下三个字段：

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
      "evidence": "状态变化的完整证据"
    }
  ]
}
```

约束：

- `body` 是自由 Markdown，不是固定统计表。它应清楚介绍 PR 改变的行为、实现路径、影响、审查结论、新 finding 导航、历史 thread 状态和必要的 known issue 链接；不要添加 Action footer；
- 标题：有新 finding 或人工确认用 `## 自动代码审查 ⬆️`，否则有未解决历史问题用 `## 自动代码审查 ❌`，其余用 `## 自动代码审查 ✅`。正文分组遵循 `findings.md`，历史状态按第 2 节；
- `comments` 只保留最终归纳后的新 finding，每项恰好包含 `path`、`line`、`start_line`、`body`；路径必须是仓库相对路径，单行使用 `start_line: null`，多行起始行不得大于 `line`；
- `thread_updates` 只保留当前 PR 中状态实际变化的历史 inline thread，每项恰好包含 `root_comment_id`、`status`、`evidence`；`status` 只能是 `resolved`、`severity_increased` 或 `reintroduced`；
- 没有新 finding 或 thread update 时使用空数组，仍提供完整 `body`；
- 文件不得超过 1 MB，不得包含额外字段、注释、Markdown fence 或 trailing text。

中央 inline finding 必须使用 [findings.md 的模板、Alert 和证明要求](../skills/agentic-review/references/findings.md#finding-内容)，段间空一行，不加“等级：”前缀。

生成 JSON 时使用本文件已预载的格式，提交前读取实际写出的 JSON，核对字段、存活 finding 与刷新后的历史 thread 状态一致；协议无法准确恢复时从 `$REVIEW_CONTROL_PATH/central/review-result.md` 补读。`submit_review` 与发布器使用同一 schema 校验，且要求本次进程已经成功刷新 thread。

## 5. 唯一提交

最后调用以下工具，直到成功封存一次；校验失败时按错误和本文件修正 JSON 后重试：

```text
submit_review({"path":"<REVIEW_WORKSPACE_PATH>/review-result.json"})
```

`submit_review` 先校验该文件，通过后才封存；校验失败不会封存，也不会消耗成功提交机会。可信 publisher 会重新验证 schema，把 `body` 与全部 inline comments 发布到本轮审查的 head，处理历史 thread，并追加运行元数据。不要通过其他工具发布，也不要在提交后继续修改结果文件。
