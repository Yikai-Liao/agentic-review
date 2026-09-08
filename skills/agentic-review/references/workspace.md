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

`$REVIEW_PREVIOUS_WORKSPACE_PATH` 是上一轮只读结果。先读取其 `notes.md` 和最终结果，再按增量影响读取相关 complete batch，将可复用结论和来源写入本轮索引；不修改历史目录。调用方已将历史 batch 复制到本轮工作区时，保留未受影响文件，只更新重开的 batch；本轮索引记录继承的 checkpoint、batch 路径、覆盖 ID 和前提未受影响的理由。调用方未复制时，在本轮工作区保存需继承的 batch 原文，以便下一轮不依赖更早的 artifact。历史结论仅作调查索引与证据缓存，当前代码、增量 diff 和最新外部记录优先。

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

change ledger 先为完整文件清单分配稳定 ID 并映射到 evidence batch，读取各 batch 的 patch 时再补齐非机械性 hunk ID，分别标记为生产行为、测试行为、性能路径或机械变化。分页读取时记录已覆盖区间和续读位置，未读 patch 保持待覆盖，全部 hunk 补齐后才能完成该文件。调用方限定范围时，将 scope 外条目标为 out-of-scope，不计为已审查。scope 内每项结束时必须是“已审查无 finding、候选已反证、新 finding、已有问题覆盖或继承自上一轮 complete batch”。继承只适用于 checkpoint 后未变化且前提未受影响的代码；增量变化触及其契约、调用方、数据流或反证，最新评论提出冲突证据，或历史 batch 不完整时，必须重新打开调查。

每个 batch 文件记录：

- 覆盖的 ledger/census ID 及跨 batch 关联；
- 共享 base/head 证据、独立契约、实际路径和待验证项；
- 候选问题、独立反证、finding 草稿和排除理由；
- 与其他 batch 可能共享的根因、触发路径和 cluster key；
- `status: complete` 或仍缺少的明确证据。

继承项保留证据原文和稳定 ID，不为本轮重新生成证明。重开调查时先将本轮对应 batch 及索引标为未完成，记录重开原因和待验证项；随后使用 `edit` 在本轮已有 batch 上局部修改受影响内容，不因重开而整份覆写。保留仍有效的证据、结论和稳定 ID；替换失效证据时，同步修正相关反证、排除理由、finding 草稿、跨 batch 关联和状态，避免只追加新证据却留下矛盾的旧结论。

新增独立调查且没有对应 batch 时，使用 `write` 创建文件。新建或编辑完成后，核对 batch 当前证据与结论一致、待验证项已处理、ledger/census 覆盖与索引一致，再将 batch 及索引标为 complete。本轮 workspace 必须保留完整的当前审查证据，使下一轮只依赖本轮 artifact 即可继续。

## 工具边界与单写者

`write` 和 `edit` 只能修改本轮工作区内的工作稿与调用方要求的最终结果，不能修改目标 working tree、index 或 base checkout。`bash` 只用于创建或删除本轮工作区及静态调查；调用方若提供专用 JSON 校验工具，只能按其权限和输出协议使用。Review 使用的外部凭证保持调用方规定的权限边界，不用于未经授权的发布。

主 Agent 独占工作稿写入，复核 Sub-agent 返回的 batch 结果后落盘；不引入多写者、锁或合并协议。

最终归纳先读取 `notes.md`、complete batch 的结论和 finding 草稿。只有存活 finding、跨 batch 根因冲突、覆盖状态不一致或无法准确确认约束时，才重新读取相关 batch 的完整证明；不重新执行已经完成且无关联候选的分析。
