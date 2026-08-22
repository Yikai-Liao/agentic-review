# Review Workspace

工作稿用于在长审查、context compaction 和可选委派之间保存事实来源，不是最终 finding 的追加列表。

## 路径和生命周期

调用方提供 `$REVIEW_WORKSPACE_PATH` 时使用该绝对路径；否则主 Agent 在操作系统临时目录创建本轮唯一目录并限制为当前用户访问。不要把工作稿放进目标仓库，以免污染 `git status`、变化集合或提交内容。

本地临时工作稿保留到 Review 完成；成功后可删除，用户要求复核时保留并报告路径。中央或其他自动化调用方自行规定 artifact 和保留期。不要记录 token、环境变量值或与审查无关的敏感信息。

## 结构

```text
review-workspace/
  notes.md
  batches/
    B1.md
    B2.md
  final-review.md 或调用方要求的最终结果
```

`notes.md` 只保存当前上下文、change ledger、evidence batch 状态、候选根因关系和最终覆盖状态，不复制每个 batch 的完整证据。

change ledger 为完整变化集合的每个文件和非机械性 hunk 分配稳定 ID，分别标记为生产行为、测试行为、性能路径或机械变化，并映射到一个或多个 evidence batch。每项结束时必须是“已审查无 finding、候选已反证、新 finding 或已有问题覆盖”。

每个 batch 文件记录：

- 覆盖的 ledger/census ID 及跨 batch 关联；
- 共享 base/head 证据、独立契约、实际路径和待验证项；
- 候选问题、独立反证、finding 草稿和排除理由；
- 与其他 batch 可能共享的根因、触发路径和 cluster key；
- `status: complete` 或仍缺少的明确证据。

完成一个 batch 后写入对应文件，再把 `notes.md` 中该 batch 状态改为 complete。新证据推翻早期结论时精确更新原 batch；准确性优先于“只写一次”。

## 单写者

主 Agent 是工作稿的唯一写入者。Sub-agent 只通过 delegation 返回指定 batch 的调查结果；主 Agent 复核后写入 batch 文件。不要让多个 Agent 并发修改 `notes.md`，也不要为工作稿引入锁或合并协议。

最终归纳先读取 `notes.md`、complete batch 的结论和 finding 草稿。只有存活 finding、跨 batch 根因冲突、覆盖状态不一致或无法准确确认约束时，才重新读取相关 batch 的完整证明；不重新执行已经完成且无关联候选的分析。
