---
name: submit-review
description: 自动 PR Review 的最终 finding 归因合并、review-result.json schema 与唯一 submit_review 提交流程。完成调查并准备最终发布时使用。
---

# Submit Review

## 最终归纳

完成全量审查后，读取完整工作稿，并重新检查所有准备发布的代码位置和相关历史 thread。若会话发生过 compact，或无法准确确认某项约束，再按需重新读取对应 skill。

然后按根因重新聚类：合并重复项，将表层症状提升到已证明的最深共享根因，删除被反证的候选，并检查每条 finding 的严重度、证据、RIGHT-side diff 位置和独立可读性。只有完成这次最终归纳后才能生成 JSON。

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

- `body` 是自由 Markdown，不是固定统计表。它应清楚介绍 PR 改变的行为、实现路径、影响、审查结论、新 finding 导航和历史 thread 状态；不要添加 Action footer。
- 推荐但不强制的叙述顺序是：`## 自动代码审查 …` → 行为与实现概述 → 影响和结论 → 新 finding → 历史 thread 状态。应按当前 PR 调整，而不是机械套模板。
- `comments` 只保留最终归纳后的新 finding。每项必须恰好包含 `path`、`line`、`start_line`、`body`；`path` 必须是仓库相对路径；单行使用 `start_line: null`，多行使用不大于 `line` 的起始行。
- `thread_updates` 只保留状态实际变化的历史 inline thread。每项必须恰好包含 `root_comment_id`、`status`、`evidence`；`status` 只能是 `suggest_resolve`、`severity_increased` 或 `reintroduced`。
- 没有新 finding 或 thread update 时使用空数组，仍然必须提供完整 `body`。
- 文件不得超过 1 MB，不得包含额外字段、注释、Markdown fence 或 trailing text。

写完后重新读取 JSON，确认工作稿中的每个已确认问题都已被合并、发布或明确排除，并用只读 `jq -e . "$REVIEW_WORKSPACE_PATH/review-result.json"` 检查 JSON 语法。

## 唯一提交

最后恰好调用一次：

```text
submit_review({"path":"review-workspace/review-result.json"})
```

`submit_review` 只封存该文件；可信 publisher 会重新验证 schema 和 PR 快照，创建一个包含 `body` 与全部 inline comments 的 Review，处理历史 thread，并追加运行元数据。不要通过其他工具发布，也不要在提交后继续修改结果文件。
