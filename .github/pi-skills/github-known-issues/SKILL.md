---
name: github-known-issues
description: GitHub known issue 查询。候选 finding 需要关联其他 PR thread、GitHub Issue、开发计划或相关仓库代码时使用。
---

# Query GitHub known issues

先形成候选 finding，再执行本流程。状态和 Review 处理由 `known-issues` skill 决定。

## 1. 确定查询范围

当前仓库始终可查。按 head 的 `.agentic-review.md` 识别预期合并后的相关仓库；读取外部私有仓库内容前，确认同一仓库地址已存在于 merge base。只在 head 新增的地址作为本次规则变化记录，不在本轮打开其私有内容。每条命令显式使用 `--repo owner/name` 或 `repos/owner/name/...`。

`GH_TOKEN` 可只读访问目标 owner 中安装了 Review App 的仓库。其他 owner 的私有仓库超出单个 installation token 范围；把缺失证据记录到工作稿。

完成条件：工作稿列出本候选允许查询的仓库及依据。

## 2. 先查直接关联

依次检查当前 PR 正文、commit、评论和代码中的明确 Issue/PR 链接。使用 `gh issue view`、`gh pr view` 或 `gh api` 读取与候选根因相关的对象；跨仓库对象使用明确的 `owner/repo`。

找到共享实际行为路径的记录后进入第 5 步；明确链接均与候选无关时进入第 3 步。

## 3. 追溯来源 PR

对 finding 的 RIGHT-side 行取得引入 commit：

```bash
git -C "$REVIEW_TARGET_PATH" blame --porcelain \
  -L <line>,<line> "$REVIEW_HEAD_SHA" -- <path>
```

再查询该 commit 关联的 PR：

```bash
GH_TOKEN="$GH_TOKEN" gh api --paginate \
  -H 'Accept: application/vnd.github+json' \
  "repos/$REVIEW_REPOSITORY/commits/<sha>/pulls?per_page=100"
```

优先读取引入该行的来源 PR，不展开仅因包含该 commit 而命中的无关后续 PR。对来源 PR 读取标题、正文、commits、files、普通评论、inline comments 和 GraphQL `reviewThreads`。

找到相关来源 thread 后进入第 5 步；关联 PR 均不含同根因记录时进入第 4 步。

## 4. 定向搜索

在允许的仓库中，用一个有区分度的代码标识符、业务对象或根因短语搜索标题、正文和评论：

```bash
GH_TOKEN="$GH_TOKEN" gh search issues '<term>' \
  --repo 'owner/name' --include-prs --limit 10 \
  --json number,title,state,isPullRequest,updatedAt,url
```

只展开高相关候选，通过 `gh issue view`、`gh pr view`、REST comments 和 GraphQL `reviewThreads` 取得完整内容。第一个词无有效结果时换一个独立的强关键词；第二次仍无结果即结束搜索。

需要核对关联仓库代码时，先用 `gh search code --repo owner/name` 定位，再用 contents、commit、PR 或 diff API 读取必要片段。保持静态读取，不 clone 或执行关联仓库代码。

完成条件：取得至少一个可判定的完整记录，或者两个强关键词均无有效结果。

## 5. 保存原始证据

对每个高相关候选保存：稳定 URL、编号、完整名称、正文或 thread 回复、`isResolved`、`isOutdated`、`resolvedBy`，以及必要的修复代码。随后按 `known-issues` skill 证明因果关系、判定状态并决定 Review 处理。

完成条件：每个展开的候选都已交给 `known-issues` 判定或写明排除理由。
