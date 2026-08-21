---
name: submit-review
description: 自动 PR Review 的最终 finding 归因合并、review-result.json schema 与唯一 submit_review 提交流程。完成调查并准备最终发布时使用。
---

# Submit Review

## 最终归纳

完成全量审查后，先读取 `notes.md` 中的覆盖状态、complete batch 的结论和 surviving finding 草稿。确认每个 ledger/census 关联都已由 complete batch 覆盖；不要为最终归纳重新执行已经完成且没有关联候选的 batch。只有 finding 可能共享根因、cluster key 冲突、覆盖状态不一致、会话发生过 compact 或无法准确确认约束时，才重新读取相关 batch 的完整证明、代码位置、历史 thread、known issue 或对应 skill。

然后按根因重新聚类：合并重复项，将表层症状提升到已证明的最深共享根因，删除被反证的候选，并检查每条 finding 的严重度、证据、RIGHT-side diff 位置和独立可读性。最终覆盖状态可用 `edit` 更新到 `notes.md`；能与 JSON 同一工具批次完成时，不为更新工作稿增加单独回合。只有完成这次最终归纳后才能生成 JSON。

## 最终 JSON

将最终文件写到 `review-workspace/review-result.json`（即 `$REVIEW_WORKSPACE_PATH/review-result.json`）。文件必须是 UTF-8 JSON 对象，且只包含以下三个字段：

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
      "status": "suggest_resolve",
      "evidence": "状态变化的完整证据"
    }
  ]
}
```

约束：

- `body` 是自由 Markdown，不是固定统计表。它应清楚介绍 PR 改变的行为、实现路径、影响、审查结论、新 finding 导航、历史 thread 状态和必要的 known issue 链接；不要添加 Action footer。
- 推荐但不强制的叙述顺序是：`## 自动代码审查 …` → 行为与实现概述 → 影响和结论 → 新 finding → 历史 thread 状态。应按当前 PR 调整，而不是机械套模板。
- `comments` 只保留最终归纳后的新 finding。每项必须恰好包含 `path`、`line`、`start_line`、`body`；`path` 必须是仓库相对路径；单行使用 `start_line: null`，多行使用不大于 `line` 的起始行。
- `thread_updates` 只保留当前 PR 中状态实际变化的历史 inline thread，不得放入其他 PR 的 thread。每项必须恰好包含 `root_comment_id`、`status`、`evidence`；`status` 只能是 `suggest_resolve`、`severity_increased` 或 `reintroduced`。
- 没有新 finding 或 thread update 时使用空数组，仍然必须提供完整 `body`。
- 文件不得超过 1 MB，不得包含额外字段、注释、Markdown fence 或 trailing text。

写完后重新读取 JSON，确认 complete batch 中每个 surviving finding 都已被合并、发布或明确排除。GitHub Actions Runner 已提供 `jq` CLI；通过 `bash` 执行只读的 `jq -e . "$REVIEW_WORKSPACE_PATH/review-result.json"` 检查 JSON 语法。

## 唯一提交

最后恰好调用一次：

```text
submit_review({"path":"review-workspace/review-result.json"})
```

`submit_review` 只封存该文件；可信 publisher 会重新验证 schema，把 `body` 与全部 inline comments 发布到本轮审查的 head，处理历史 thread，并追加运行元数据。后续快照由同一 PR 的下一轮 Review 串行处理。不要通过其他工具发布，也不要在提交后继续修改结果文件。
