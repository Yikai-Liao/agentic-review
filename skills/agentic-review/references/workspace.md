# Review 工作稿

工作稿保存跨 context compaction、增量审查和委派的证据与覆盖状态。

## 路径和生命周期

调用方提供 `$REVIEW_WORKSPACE_PATH` 时使用该绝对路径。否则在当前 worktree 的 Git 管理目录创建本轮唯一工作区：

```bash
git_dir="$(git rev-parse --absolute-git-dir)"
workspace_root="$git_dir/agentic-review"
mkdir -p "$workspace_root"
chmod 700 "$workspace_root"
mktemp -d "$workspace_root/review.XXXXXX"
```

使用 `mktemp` 输出的绝对路径；工作稿不进入 working tree 或变化集合。

本地 Review 成功输出后删除本轮目录；中断或用户要求复核时保留并报告路径。调用方自行规定工作区的 artifact 和保留期。不要记录 token、环境变量值或与审查无关的敏感信息。

`$REVIEW_PREVIOUS_WORKSPACE_PATH` 是上一轮只读结果。读取其 `notes.md`、最终结果及与增量相关的 complete batch，将可复用结论和来源写入本轮索引；不修改或复制历史文件。历史结论仅作调查索引与证据缓存，当前代码、增量 diff 和最新外部记录优先。

## 结构

```text
review-workspace/
  notes.md
  batches/
    B1.md
    B2.md
  final-review.md 或调用方要求的最终结果
```

`notes.md` 保存上下文、change ledger、batch 状态、候选根因关系和最终覆盖状态；完整证据留在 batch 文件。

change ledger 为完整变化集合的每个文件和非机械性 hunk 分配稳定 ID，分别标记为生产行为、测试行为、性能路径或机械变化，并映射到一个或多个 evidence batch；调用方限定范围时，将 scope 外条目标为 out-of-scope，不计为已审查。scope 内每项结束时必须是“已审查无 finding、候选已反证、新 finding、已有问题覆盖或继承自上一轮 complete batch”。继承只适用于 checkpoint 后未变化且前提未受影响的代码；增量变化触及其契约、调用方、数据流或反证，最新评论提出冲突证据，或历史 batch 不完整时，必须重新打开调查。

每个 batch 文件记录：

- 覆盖的 ledger/census ID 及跨 batch 关联；
- 共享 base/head 证据、独立契约、实际路径和待验证项；
- 候选问题、独立反证、finding 草稿和排除理由；
- 与其他 batch 可能共享的根因、触发路径和 cluster key；
- `status: complete` 或仍缺少的明确证据。

写完 batch 文件再将索引状态改为 complete；新证据推翻结论时更新原 batch。

## 工具边界与单写者

`write` 和 `edit` 只能修改本轮工作区内的工作稿与调用方要求的最终结果，不能修改目标 working tree、index 或 base checkout。`bash` 只用于创建或删除本轮工作区及静态调查；调用方若提供专用 JSON 校验工具，只能按其权限和输出协议使用。Review 使用的外部凭证保持调用方规定的权限边界，不用于未经授权的发布。

主 Agent 独占工作稿写入，复核 Sub-agent 返回的 batch 结果后落盘；不引入多写者、锁或合并协议。

最终归纳先读取 `notes.md`、complete batch 的结论和 finding 草稿。只有存活 finding、跨 batch 根因冲突、覆盖状态不一致或无法准确确认约束时，才重新读取相关 batch 的完整证明；不重新执行已经完成且无关联候选的分析。
