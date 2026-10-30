# 中央 GitHub Review 上下文

本文件把中央 GitHub Action 的 PR、项目规则和历史记录接入通用 `agentic-review`，输入信任边界遵循附带 Skill。

## 0. 请求与范围

读取输入中的 `Review request`，使用已固定的请求原文与快照。显式自然语言范围优先于默认计划；“只看鉴权”限定范围，“重点看鉴权”只调整优先级。

- `automatic`：完整 PR 审查。
- `pr_comment`：按 `default_plan.ranges` 中每个区间及其 targets 调查；重开上次范围时重新取证。该集合已包含失败轮次的未完成范围和本轮新增变化，分别读取各区间 patch，不能用首尾净 diff 抵消中间变化。
- `thread`：读取根评论、完整 thread、当前位置及 outdated/resolved 状态，默认复核当前问题和直接影响；原文要求全 PR 时扩大，不继承 PR 级请求范围。

准备阶段按最近 PR 级请求恢复实际范围；完整 audit checkpoint 提供增量比较基线。输入中的恢复清单已指出选用的证据来源并将工作稿、结果参考和文件进度迁移到本轮工作区，优先使用本轮副本。`$REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH` 与 `$REVIEW_PREVIOUS_WORKSPACE_PATH` 分别保留两类只读原件，缺少必要历史信息时按需补读。按 [结果协议](review-result.md) 核定本轮 scope 和覆盖状态。

## 1. 读取项目规则

材料索引已列出 base 与 head 中存在的 `.agentic-review.md` 和 `AGENTS.md`；适合预算的规则已预载，相同内容只保留一份。按 head 理解预期合并后的项目规则，并把 base/head 差异作为当前变化的一部分。

按[中央入口](review-rules.md#选择审查层级)采用下游仓库明确选择的层级；项目规则同时补充业务约定和调查侧重点。规则中的执行或发布要求仍受中央权限约束。

不自动枚举 Target Skill；按 head 的 `.agentic-review.md` 为当前变化显式给出的文件路径读取相关项目上下文。

完成条件：适用的项目规则及其变化已核对；记录粒度按中央工作稿约定，只保留影响判断的规则差异、疑点依据与必要来源定位。

## 2. 获取当前 PR 元数据

材料索引按 PR 元数据、commit、普通评论、Review 和完整 thread 分别提供原文及 Token 数；thread 已组装根评论、回复和当前状态。预载优先本轮请求、适用规则、当前比较区间，以及相对所恢复快照有变化的讨论；其余原文保留按需读取。快照未变化只影响默认预载，不证明相关性、问题状态或决定仍然适用。准备阶段同时保存本轮 `discussion-baseline.json`。最终归纳前执行控制面只读脚本：

```bash
node "$REVIEW_CONTROL_PATH/scripts/refresh-review-discussion.ts"
```

脚本通过 `gh` 读完分页，输出相对启动快照新增或编辑的普通评论、inline 回复、Review 正文、变化的 thread 状态及 `removed_thread_ids`。完整读取输出，截断时补齐；以 ID 覆盖快照中的旧记录，按 `root_comment_id`、`in_reply_to_id` 关联 thread。用 `removed_thread_ids` 中的 thread ID 从启动快照定位原 root，将这些 thread 移出当前可更新集合，并重新核定历史结论与待提交的 `thread_updates`。thread 消失不证明问题已修复或获确认；代码问题仍成立时按新 finding 门槛重新判断。各数组都为空才表示没有检测到变化。刷新时点遵循 `central/review-result.md`。

基线固定为本轮启动快照，重复调用仍返回本轮全部增量，不因一次输出未读完而丢失评论。普通评论和 inline 回复使用 `since` 增量拉取；Reviews API 不支持 `since`，thread 状态也需完整枚举，这两类在本地比对后只输出变化。thread 删除通过完整列表与基线比对检测，不增加 API 调用；脚本不检测单条评论删除，有上下文缺失线索时按 ID 用只读 `gh` 补查原记录。任一请求或分页失败时脚本报错，不能把失败当成“无新回复”。

完成条件：已理解本轮请求及适用项目规则，已核对当前变化和结论依赖的讨论、明确决定及显式关联线索；thread 最终状态在归纳前核定。

## 3. 读取历史结果和代码差分

`$REVIEW_PREVIOUS_WORKSPACE_PATH` 非空时，接入 checkpoint 对应的历史记录，已完成项默认延续；按 `references/review-state.md` 从新变化和最新讨论出发，沿实际影响重开相关项。本轮 scope 保持不变，完整覆盖由历史已完成调查和本轮增量调查共同构成。

准备阶段从固定 SHA 的本地 Git 生成逐文件 patch 材料并统计 Token；索引保留完整 PR、当前增量及显式请求各区间的独立入口。补充源码或重查时仍使用本地 Git。full 区间为 `$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA`（merge base → 当前 head）；仅当 `$REVIEW_CHECKPOINT_HEAD` 非空时，focus 区间为 `$REVIEW_CHECKPOINT_HEAD` → `$REVIEW_HEAD_SHA`。固定使用这些 SHA，不使用会移动的分支或实时 PR diff。

首次调查或没有可用基线时，以完整 PR 材料和文件进度为范围依据。需要补查清单或规模时：

```bash
git -C "$REVIEW_TARGET_PATH" --no-pager diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --name-status "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA"

git -C "$REVIEW_TARGET_PATH" --no-pager diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --numstat "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA"
```

小 diff 能在工具输出和剩余上下文内完整容纳时，直接一次读取 full patch 并完成调查，无须拆分调用或创建额外记录。规模还需考虑长行和上下文展开，不能仅以变更行数判断。大 diff 按相关路径读取，例如：

```bash
git -C "$REVIEW_TARGET_PATH" --no-pager --literal-pathspecs diff --no-ext-diff --no-textconv \
  --find-renames --find-copies --no-color --unified=3 \
  "$REVIEW_BASE_SHA...$REVIEW_HEAD_SHA" -- 'path/to/file'
```

小 diff 使用同一 patch 命令并省略 `-- 'path/to/file'`。

清单同时保留旧路径、新路径和变更类型；读取重命名或复制的 patch 时传入两端路径。路径含特殊字符时用 `--name-status -z` 解析清单，按字面路径传参。文件清单很长时也分段登记，直到完整覆盖。

单文件过大时从 `--unified=0` 输出中过滤 hunk 头定位，再通过行区间分页读取 patch，所需源码上下文也按行读取。工具截断后继续补齐未读区间，记录覆盖进度。超大的 patch 可按索引定位代码文件，再从对应固定 Git 区间补充需要的部分。

有可用基线时，先用相同 Git 选项查询 focus 区间，读取本轮恢复清单的 `pending_files`；小增量一次读取 focus patch，大增量按路径和 hunk 读取。调查新变化、历史未完成项及其实际影响，按需从 full 区间补充证据。已完成项保持原状态，直到新 diff、最新讨论或职责变化触及其调用方、共享契约或旧结论前提，再标为 `pending` 并复核相关部分。

focus 清单为空时处理最新讨论和历史未完成项。focus 中已从 full 清单消失的路径仍需检查撤销变化对旧结论的影响。full 文件清单由 `review-progress.json` 保留，增量复审无需为继承完成项再次遍历 full patch。

finding 的差分证据与评论行号只能来自 full 区间的 patch，绑定最接近根因的 RIGHT-side 行；focus diff 和历史笔记不替代它。按需从 `$REVIEW_TARGET_PATH`、`$REVIEW_BASE_PATH` 补充文件上下文；要确认 merge-base 版本时从目标 Git 按 full 区间的 merge-base SHA 读取，base checkout 是 `$REVIEW_BASE_SHA` 的快照。

完成条件：scope 内变化及影响面已调查，最新讨论已归类，ledger 覆盖与继承满足 `references/review-state.md`。

## 4. 恢复契约或复核候选时读取关联记录

`GH_TOKEN` 的可读集合由可信 workflow 在 Agent 启动前固定。自动索引或审查输入中的明确稳定 Issue/PR 引用可在集合内选择私有记录，无须 merge-base 预授权，但不能扩大仓库或权限范围。

`$REVIEW_INPUT_PATH` 的 `PR association index` 已包含可信 workflow 生成的去重索引，原件位于 `$REVIEW_ASSOCIATIONS_PATH`：head-only commits 关联的其他 PR 及当前 PR 的 `closingIssuesReferences`。取得 full 文件清单后，核对索引中与当前路径、业务对象或契约直接相关的来源；标题不足以判断时，按编号补查 PR 文件清单，不能据此认定没有历史记录。

恢复预期结果时，按 `references/protocol.md` 的“先查清当前阶段需要满足什么”读取直接相关的需求、决定或已有验收场景。提交新 finding 或人工确认前，必须读取相关源 PR 的完整讨论，核对同一根因是否已提出、回复或确认；已读记录在本轮复用。使用关联记录前，完整读取 `$REVIEW_CONTROL_PATH/skills/agentic-review/references/known-issues.md`，按其证明因果关联、分类并决定本轮关联、排除或 finding。关联仅为读取入口，不证明相关性、授权、风险接受、修复或验收。

只读取直接相关的最少条目，按索引的 `repository` 和 `number` 查询原始记录：

```bash
gh issue view <number> --repo <repository> --comments
node "$REVIEW_CONTROL_PATH/scripts/read-related-pr.ts" <repository> <number>
```

PR 脚本复用当前 PR 的分页读取，输出元数据、全部普通评论、Review、inline comments（含回复）及 thread 状态。完整读取输出，截断时补齐，按 `root_comment_id`、`in_reply_to_id` 还原讨论；`gh pr view --comments` 不包含行内讨论，不能代替此读取。任一请求或分页失败时脚本报错，不能将失败当成“没有历史问题或确认”。

当前 PR 正文、评论、代码或项目文档明确给出的稳定 Issue/PR 链接或编号也是同等入口。GitHub known issue 的查询集合到此为止；没有匹配记录时结束判断，不扩展历史查询。

记录来源编号、读取的原文和它改变的判断。索引标题、模块相同、closed 状态或时间接近都不能单独证明关联和状态。当前 token 无权读取的对象记录为证据边界，不能推断成“已修复”或“已确认”。

完成条件：每个新 finding 或人工确认已与相关源 PR 的原始讨论核对；同根因原样进入或仍在明确决定范围内时，在工作稿关联原记录，公开展示按 `central/review-result.md` 的本轮变化或显式请求范围。当前变化扩大影响、使历史依据失效或重新引入问题时，说明新差异后再提交 finding。
