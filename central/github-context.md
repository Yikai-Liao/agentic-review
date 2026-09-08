# 中央 GitHub Review 上下文

本文件把中央 GitHub Action 的 PR、项目规则和历史记录接入通用 `agentic-review`，输入信任边界遵循附带 Skill。

## 1. 读取项目规则

`$REVIEW_INPUT_PATH` 已包含 merge base 与 head 中存在的 `.agentic-review.md` 和 `AGENTS.md`。按 head 理解预期合并后的项目规则，并把 base/head 差异作为当前变化的一部分。

不自动枚举 Target Skill；按 head 的 `.agentic-review.md` 为当前变化显式给出的文件路径读取相关项目上下文。

完成条件：工作稿记录采用的项目规则、base/head 规则差异，以及实际读取的显式引用文件与用途。

## 2. 获取当前 PR 元数据

`$REVIEW_INPUT_PATH` 已包含 PR 元数据、commit、普通评论、Review、inline comments 和 thread 状态的启动快照。准备阶段同时保存本轮 `discussion-baseline.json`。最终归纳前执行控制面只读脚本：

```bash
node "$REVIEW_CONTROL_PATH/scripts/refresh-review-discussion.ts"
```

脚本通过 `gh` 读完分页，只输出相对启动快照新增或编辑的普通评论、inline 回复、Review 正文及变化的 thread 状态。完整读取输出，截断时补齐；以 ID 覆盖快照中的旧记录，按 `root_comment_id`、`in_reply_to_id` 关联 thread，结合已读原文判断，空数组表示该类没有增量。刷新时点遵循 `central/review-result.md`。

基线固定为本轮启动快照，重复调用仍返回本轮全部增量，不因一次输出未读完而丢失评论。普通评论和 inline 回复使用 `since` 增量拉取；Reviews API 不支持 `since`，thread 状态也需完整枚举，这两类在本地比对后只输出变化。脚本不检测已删除评论；有删除或上下文缺失线索时按 ID 用只读 `gh` 补查原记录。任一请求或分页失败时脚本报错，不能把失败当成“无新回复”。

完成条件：输入快照中的元数据和讨论已读取，工作稿记录显式关联线索；thread 最终状态在归纳前核定。

## 3. 读取历史结果和代码差分

`$REVIEW_PREVIOUS_WORKSPACE_PATH` 非空时，按 `workspace.md` 接入 checkpoint 对应的只读工作稿；先用最新 PR 讨论、thread 状态和增量 diff 更新前提，再判定继承或重开。

本地 Git 是 diff 的唯一来源。full 区间为 `$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA`（merge base → 当前 head）；仅当 `$REVIEW_CHECKPOINT_HEAD` 非空时，focus 区间为 `$REVIEW_CHECKPOINT_HEAD` → `$REVIEW_HEAD_SHA`。固定使用这些 SHA，不使用会移动的分支或实时 PR diff。

先查询 full 区间的完整文件清单和规模：

```bash
git -C "$REVIEW_TARGET_PATH" --no-pager diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --name-status "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA"

git -C "$REVIEW_TARGET_PATH" --no-pager diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --numstat "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA"
```

小 diff 能在工具输出和剩余上下文内完整容纳时，直接一次读取 full patch，用一个 batch 完成审查，无须拆分调用。规模还需考虑长行和上下文展开，不能仅以变更行数判断。大 diff 按当前 batch 的路径读取，例如：

```bash
git -C "$REVIEW_TARGET_PATH" --no-pager --literal-pathspecs diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --no-color --unified=3 \
  "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA" -- 'path/to/file'
```

小 diff 使用同一 patch 命令并省略 `-- 'path/to/file'`。

清单同时保留旧路径、新路径和变更类型；读取重命名或复制的 patch 时传入两端路径。路径含特殊字符时用 `--name-status -z` 解析清单，按字面路径传参。文件清单很长时也分段登记，直到完整覆盖。

单文件过大时从 `--unified=0` 输出中过滤 hunk 头定位，再通过行区间分页读取 patch，所需源码上下文也按行读取。工具截断后继续补齐未读区间，记录覆盖进度。diff 直接从 Git 读取，不预生成或合并为单个文件。

无历史工作稿时逐批覆盖全部变化；有历史时用相同 Git 选项查询 focus 区间，优先调查其文件、hunk 和影响面，再从 full 区间补充历史未完成项及 finding 位置，其余按继承条件复用。focus 清单为空只表示没有净代码变化，仍需处理最新讨论和历史未完成项；focus 中已从 full 清单消失的路径也要检查撤销变化对旧结论的影响。

finding 的差分证据与评论行号只能来自 full 区间的 patch，绑定最接近根因的 RIGHT-side 行；focus diff 和历史笔记不替代它。按需从 `$REVIEW_TARGET_PATH`、`$REVIEW_BASE_PATH` 补充文件上下文；要确认 merge-base 版本时从目标 Git 按 full 区间的 merge-base SHA 读取，base checkout 是 `$REVIEW_BASE_SHA` 的快照。

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
