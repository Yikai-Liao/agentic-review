# 中央 Review 结果

本文件只定义中央 Action 的持久化、GitHub thread 更新和可信发布格式。finding 门槛、严重度和根因归纳来自可信 `agentic-review` Skill。

## 1. 中央工作稿

使用 workflow 提供的隔离目录 `$REVIEW_WORKSPACE_PATH`，遵循 `workspace.md`；工作稿作为限期、受权限保护的 Actions artifact 保留。

调查前调用 `set_review_scope` 记录实际范围、比较区间和判断依据，保留返回的 `scope_id`。工具参数定义字段；targets 应足以让下一轮恢复覆盖范围。

workflow 在 Agent 启动前为完整 PR 生成 `review-coverage.json` 的 `ledger`（文件清单），并将清单摘要独立传给可信发布器。保留每个条目的 `path`；每个文件及其非机械 hunk 的证明写入 `batches/<batch-id>.md`，batch ID 只用字母、数字、下划线和连字符。完成后把对应条目写为 `{"path":"src/example.ts","status":"complete","batches":["B1"]}`，并将所有已完成 batch ID 记入 `completed_batches`。未完成条目保持 `pending`；局部范围外条目使用 `out_of_scope` 和空 `batches`，full 范围不允许排除条目。中央 ledger 提供文件级完成校验，hunk、census 与证据充分性仍遵循 `workspace.md`。

发布器校验清单未缺失、scope 内条目全部完成、batch 清单一致且证据文件非空；任一不满足就失败。automatic 只能使用完整 PR 的 `full` scope，增量 diff 仅影响调查优先级。`published` 和 `complete_audit` 由可信发布器决定，局部成功不代表完整 audit。

## 2. 历史 thread 状态

把存活候选与当前 PR 已有 inline thread 和最新回复比较，一个根因只保留一条：

- 未变化且未解决：不生成 thread update，正文列为 `⏳ 仍未解决`；
- 已修复、被更强代码/API/测试契约证据推翻，或已由当前 PR 明确回复确认：`resolved`；
- 影响、成本或严重度扩大：`severity_increased`；
- 已解决问题重新出现，或当前实现超出既有确认范围：`reintroduced`。

文档同步记录已确认决定时保持 `resolved`，不能仅因决定写入当前 head 而标记 `reintroduced`。

正文每个历史 thread 只列一行状态、finding 标题和链接；状态用 `⏳ 仍未解决`、`⚠️ 风险升级`、`🔁 问题重现`、`✅ 已关闭`，完整证据只写入 thread update。T2→T1、P2→P1/P0 或性能从有界路径变为无界/常见路径属风险升级；测试问题升级为生产问题时更新原 thread。

使用原 thread 的 root comment ID，每轮最多更新一次；最新 `Pi thread 状态更新` 相同时不重复。publisher 只对 Review App bot 创建的 root thread 执行 resolve/reopen；人工 root 可以回复，但不能自动改变状态。正文按发布后状态书写，本轮 `resolved` 记作 `✅ 已关闭`，不算未解决。

## 3. 最终归纳

按 `workspace.md` 核对 scope 内 ledger/census 覆盖和继承，按 `findings.md` 归纳最深共享根因、严重度与证据；更新 `notes.md` 最终状态后再生成 JSON。batch 重读条件遵循 `workspace.md`；历史 thread、known issue 或规则无法准确恢复时补读相关来源。局部 scope 的正文应明确结论范围。

## 4. 最终 JSON

完成 scope 内全部 batch 和最终根因归纳后，将文件写到 `$REVIEW_WORKSPACE_PATH/review-result.json`。文件必须是 UTF-8 JSON 对象，并引用已由 `set_review_scope` 写入的 `scope_id`：

```json
{
  "body": "完整的 Markdown Review 正文",
  "scope_id": "本轮 scope manifest 的 id",
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
  ],
  "request_reply": null
}
```

约束：

- `body` 是自由 Markdown，不是固定统计表。它应清楚介绍 PR 改变的行为、实现路径、影响、审查结论、新 finding 导航、历史 thread 状态和必要的 known issue 链接；不要添加 Action footer；
- 标题：有新 finding 或人工确认用 `## 自动代码审查 ⬆️`，否则有未解决历史问题用 `## 自动代码审查 ❌`，其余用 `## 自动代码审查 ✅`。正文分组遵循 `findings.md`，历史状态按第 2 节；
- `comments` 只保留最终归纳后的新 finding，每项恰好包含 `path`、`line`、`start_line`、`body`；路径必须是仓库相对路径，单行使用 `start_line: null`，多行起始行不得大于 `line`；
- `thread_updates` 只保留当前 PR 中状态实际变化的历史 inline thread，每项恰好包含 `root_comment_id`、`status`、`evidence`；`status` 只能是 `resolved`、`severity_increased` 或 `reintroduced`；
- `scope_id` 必须匹配本轮工作稿的结构化范围；`request_reply` 必须存在，thread @ 请求填写针对原 thread 的答复，即使结论没有变化，其他请求填写 `null`；
- 没有新 finding 或 thread update 时使用空数组，仍提供完整 `body`；
- 文件不得超过 1 MB，不得包含未定义字段、注释、Markdown fence 或 trailing text。

中央 inline finding 必须使用 [findings.md 的模板、Alert 和证明要求](../skills/agentic-review/references/findings.md#finding-内容)，段间空一行，不加“等级：”前缀。

提交前重新读取本文件和实际写出的 JSON，核对字段、存活 finding 与历史 thread 状态一致。`submit_review` 与发布器使用同一 schema 校验。

## 5. 唯一提交

最后调用以下工具，直到成功封存一次；校验失败时按错误和本文件修正 JSON 后重试：

```text
submit_review({"path":"<REVIEW_WORKSPACE_PATH>/review-result.json"})
```

`submit_review` 先校验该文件、`scope_id` 与工作稿 scope，通过后才封存；校验失败不会封存，也不会消耗成功提交机会。可信 publisher 会再次验证 schema、scope、请求身份、root comment 和 bot ownership，把 `body` 与全部 inline comments 发布到本轮审查的 head，处理历史 thread，并追加运行元数据。不要通过其他工具发布，也不要在提交后继续修改结果文件。
