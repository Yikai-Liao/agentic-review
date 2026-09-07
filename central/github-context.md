# 中央 GitHub Review 上下文

本文件把中央 GitHub Action 的 PR、项目规则和历史记录接入通用 `agentic-review`，输入信任边界遵循附带 Skill。

## 1. 读取项目规则

`$REVIEW_INPUT_PATH` 已包含 merge base 与 head 中存在的 `.agentic-review.md` 和 `AGENTS.md`。按 head 理解预期合并后的项目规则，并把 base/head 差异作为当前变化的一部分。

不自动枚举 Target Skill；按 head 的 `.agentic-review.md` 为当前变化显式给出的文件路径读取相关项目上下文。

完成条件：工作稿记录采用的项目规则、base/head 规则差异，以及实际读取的显式引用文件与用途。

## 2. 获取当前 PR 元数据

`$REVIEW_INPUT_PATH` 已包含 PR 元数据、commit、普通评论、Review 和 inline comments 的启动快照。调查中需要最新 thread 状态时调用 `refresh_review_threads`；最终归纳前的刷新时点见 `central/review-result.md`。普通评论中影响候选的决定也应按需用只读 `gh` 补查。

完成条件：输入快照中的元数据和讨论已读取，工作稿记录显式关联线索；thread 最终状态在归纳前核定。

## 3. 读取历史结果和代码差分

`$REVIEW_PREVIOUS_WORKSPACE_PATH` 非空时，按 `workspace.md` 接入 checkpoint 对应的只读工作稿；先用最新 PR 讨论、thread 状态和增量 diff 更新前提，再判定继承或重开。

输入始终给出完整变更文件清单和 full diff 路径；full diff 文件始终可读。无历史工作稿或全部变更均为增量时，输入直接展开 full diff；增量轮只展开 focus diff，无净变化时不展开代码差分。`$REVIEW_MODE`：

- `initial`：没有可用 checkpoint；
- `incremental_all`：完整 diff 都在 checkpoint 之后；
- `incremental`：focus diff 是 checkpoint 到当前 head 的净变化；
- `incremental_unchanged`：该区间没有净代码变化。

增量轮先读上一轮 `notes.md` 和最终结果，将完整文件清单与历史 ledger 对齐，再根据 focus、讨论和契约影响选择 full diff 的相关部分及 batch。共享契约影响广泛、历史证据不完整或无法判定继承时，可选择完整读取 full diff。完整文件清单用于登记覆盖，不能单独证明某个 hunk 已审查；未继承项必须读取并调查。

finding 的差分证据与评论行号只能来自 full diff，绑定最接近根因的 RIGHT-side 行；focus diff 和历史笔记不替代它。按需从 `$REVIEW_TARGET_PATH`、`$REVIEW_BASE_PATH` 补充文件上下文，不重复读取或生成已有 diff。

完成条件：checkpoint 后的每项变化及其影响面已经调查，最新讨论已归类；完整 diff 中每个文件都进入本轮 ledger，并标为本轮覆盖、待覆盖或满足 `workspace.md` 条件的历史继承。

## 4. 在 finding 候选成立后读取关联记录

`GH_TOKEN` 的可读集合由可信 workflow 在 Agent 启动前固定。自动索引或审查输入中的明确稳定 Issue/PR 引用可在集合内选择私有记录，无须 merge-base 预授权，但不能扩大仓库或权限范围。

代码与契约已建立候选，且历史可能改变业务授权、归因、严重度、去重或状态时才查询。关联仅为读取入口，不证明相关性、授权、风险接受、修复或验收。

`$REVIEW_ASSOCIATIONS_PATH` 由可信 workflow 生成，包含 head-only commits 关联的其他 PR 及当前 PR 的 `closingIssuesReferences`。只选与候选路径、业务对象或契约直接相关的最少条目，按 `repository` 和 `number` 读取原始记录：

```bash
gh issue view <number> --repo <repository> --comments
gh pr view <number> --repo <repository> --comments
```

当前 PR 正文、评论、代码或项目文档明确给出的稳定 Issue/PR 链接或编号也是同等入口。GitHub known issue 的查询集合到此为止；没有匹配记录时结束判断，不扩展历史查询。

记录来源编号、读取的原文和它改变的判断。索引标题、模块相同、closed 状态或时间接近都不能单独证明关联和状态。当前 token 无权读取的对象记录为证据边界，不能推断成“已修复”或“已确认”。
