---
name: github-review-context
description: GitHub 当前 PR 上下文。开始 Review、读取当前 PR 评论与 thread、定位 base/head 文件或解释增量 diff 时使用。
---

# GitHub current PR context

## 1. 读取仓库规则

读取 merge base 和 head 中存在的 `.agentic-review.md`。按 head 理解预期合并后生效的项目规则，并把 base/head 差异作为当前 PR 的审查对象。head 新增的外部仓库地址可以被识别，但不能在同一轮授权读取新的私有仓库。

完成条件：工作稿记录本轮采用的下游规则，以及 base/head 规则差异。

## 2. 获取当前 PR 元数据

所有 GitHub 查询显式指定目标仓库：

```bash
GH_TOKEN="$GH_TOKEN" gh pr view "$REVIEW_PULL_NUMBER" \
  --repo "$REVIEW_REPOSITORY" \
  --json title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,commits,files
GH_TOKEN="$GH_TOKEN" gh api --paginate \
  "repos/$REVIEW_REPOSITORY/issues/$REVIEW_PULL_NUMBER/comments?per_page=100"
GH_TOKEN="$GH_TOKEN" gh api --paginate \
  "repos/$REVIEW_REPOSITORY/pulls/$REVIEW_PULL_NUMBER/comments?per_page=100"
GH_TOKEN="$GH_TOKEN" gh api --paginate \
  "repos/$REVIEW_REPOSITORY/pulls/$REVIEW_PULL_NUMBER/reviews?per_page=100"
```

读取全部普通评论、Review、inline comments 和 commit 信息。它们用于恢复上下文和识别关联线索；本地 diff 是当前 PR 代码差分的来源。

需要判断当前 PR thread 状态时，用 `gh api graphql` 读取 `reviewThreads` 的 `isResolved`、`isOutdated`、`resolvedBy` 和完整 comments，并用首条评论的 `databaseId` 对应 root comment。

完成条件：当前 PR 的元数据和全部讨论已读取一次，工作稿记录显式关联线索和当前 thread 状态。

## 3. 读取代码差分

优先读取 `$REVIEW_FOCUS_DIFF_PATH` 安排调查顺序，再完整读取 `$REVIEW_DIFF_PATH`。`$REVIEW_MODE` 的含义：

- `initial`：没有可用 checkpoint；
- `incremental_all`：完整 diff 都在 checkpoint 之后；
- `incremental`：focus diff 是 checkpoint 到当前 head 的净变化；
- `incremental_unchanged`：该区间没有净代码变化。

完整 diff 是 finding 的唯一差分证据；focus diff 不能缩小范围、独立证明行为变化或提供评论行号。用 `$REVIEW_TARGET_PATH` 和 `$REVIEW_BASE_PATH` 补充完整文件上下文，不重复生成已有 diff。每条 finding 绑定完整 diff 中最接近根因的 RIGHT-side 行。

完成条件：完整 diff 中每个文件都已进入工作稿的“已覆盖”或“待覆盖”清单。

候选 finding 需要查询其他 PR、Issue 或关联仓库时，再加载 `known-issues` 和 `github-known-issues`；当前上下文阶段只记录线索。
