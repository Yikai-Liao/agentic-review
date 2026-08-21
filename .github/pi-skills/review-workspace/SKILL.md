---
name: review-workspace
description: 长时间自动 PR Review 的持久化工作稿规则。开始审查、记录线索证据、维护覆盖范围和关联关系时使用。
---

# Review Workspace

开始分析后立即在 `$REVIEW_WORKSPACE_PATH/notes.md` 创建索引。索引只保存当前上下文、change ledger、evidence batch 状态、候选根因关系和最终覆盖状态，不累计复制每个 batch 的完整证据。

## 工作区结构

```text
review-workspace/
  notes.md
  batches/
    B1.md
    B2.md
  review-result.json
```

change ledger 为完整 diff 的每个文件和非机械性 hunk 分配稳定 ID，分别标记为生产行为、测试行为、性能路径或机械变化，并把每项映射到一个或多个 evidence batch。每项结束时必须是“已审查无 finding、候选已反证、新 finding 或已有 thread 覆盖”。

每个 batch 文件记录：

- 覆盖的 ledger/census ID 及跨 batch 关联；
- 共享 base/head 证据、独立契约、实际路径和待验证项；
- 候选问题、独立反证、finding 草稿和排除理由；
- 与其他 batch 可能共享的根因、触发路径和 cluster key；
- `status: complete` 或仍缺少的明确证据。

完成一个 batch 后用 `write` 新建对应文件，再用 `edit` 将 `notes.md` 中该 batch 的状态改为 complete。正常情况下不把既有 batch 内容复制进后续文件，也不反复重写完整 `notes.md`；后续证据推翻早期结论时，重新打开并用 `edit` 精确更新原 batch，准确性优先于“只写一次”。

最终归纳只先读取 `notes.md`、complete batch 的结论和 finding 草稿。只有 surviving finding、跨 batch 根因冲突或覆盖状态不一致时，才重新读取相关 batch 的完整证明；不重新执行已经完成且无关联候选的分析。

## 工具边界

`write` 和 `edit` 只能修改 `$REVIEW_WORKSPACE_PATH` 内的工作稿与最终 JSON，不能修改 target/base checkout 或其他路径。`bash` 仍是只读调查工具；仅允许在工作区创建目录，以及使用 Runner 已安装的 `jq` CLI 做 JSON 语法检查。GitHub token 保持只读。

工作稿是受权限保护、限期保留的 Actions artifact。不要记录 token、环境变量值或与审查无关的敏感信息。工作稿不是 append-only finding 列表；发现更深层根因时应更新原 batch，多个现象属于同一根因时在最终归纳中合并。
