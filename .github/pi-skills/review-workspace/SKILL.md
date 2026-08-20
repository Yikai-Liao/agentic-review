---
name: review-workspace
description: 长时间自动 PR Review 的持久化工作稿规则。开始审查、记录线索证据、维护覆盖范围和关联关系时使用。
---

# Review Workspace

开始分析后立即在 `review-workspace/notes.md`（即 `$REVIEW_WORKSPACE_PATH/notes.md`）创建工作稿，并在整个审查期间持续更新。用 change ledger 覆盖完整 diff 的每个文件和非机械性 hunk，分别标记为生产行为、测试行为、性能路径或机械变化；每项结束时必须是“已审查无 finding、候选已反证、新 finding 或已有 thread 覆盖”。

工作稿还要记录：

- 候选问题、独立反证、base/head 证据和待验证项；
- finding 之间可能共享的根因、触发路径、相互影响和合并关系；
- 当前 PR 与跨 PR thread、Issue、开发计划等 known issue 的关联和当前状态；
- 已推翻或降级的线索及原因。

工作稿用于保存调查状态，不是 append-only finding 列表；change ledger 不复制到最终 Review。发现更深层根因时，应改写早期表层结论；多个现象属于同一根因时，应在工作稿中合并。不要因已写入工作稿就停止反证。

只能用 `write` 在 `$REVIEW_WORKSPACE_PATH` 内写文件。工作稿会作为受权限保护、限期保留的 Actions artifact 提供给维护者，因此不要记录 token、环境变量值或与审查无关的敏感信息。
