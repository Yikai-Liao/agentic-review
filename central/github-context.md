# 中央 GitHub Review 上下文

本文件把中央 GitHub Action 的 PR、项目规则和历史记录接入通用 `agentic-review`，输入信任边界遵循附带 Skill。

## 0. 请求与范围

`$REVIEW_INPUT_PATH` 的 `Review request` 是本轮不可变请求记录，包含 `source`、评论与 thread identity、原文、实际开始时固定的 base/head、`comparison_start`、`run_id` 和 `run_attempt`。先按自然语言理解原文，再决定范围：显式范围优先于 thread 隐含范围，thread 隐含范围优先于 PR 默认规则。`pr_comment` 重新调查最近一次 PR 级请求的实际范围；request preparation 另外提供三类事实：无净变化时重开上次实际 scope 并重新取证，不能把空 diff 当作已完成；有净变化时提供比较区间及新增直接影响；上次 scope 有失败或未完成 batch 时提供待补覆盖。工作稿 `review-coverage.json` 的 `default_plan` 给出本轮比较区间；存在 `pending_scope` 时，同时读取其中的 targets 和原始比较区间，把待补范围纳入本轮实际 scope 与 ledger。新增变化的范围覆盖整个比较区间及直接影响，不受上次 focused targets 限制。继承标识包含 run 和 attempt；base 改变或历史提交无法比较时使用当前完整 PR 区间重新调查。Agent 使用这些事实安排调查，不把关键词猜测写成范围解析器。`thread` 默认调查当前问题及直接影响，只有原文明确要求全 PR 时才扩大；它不继承 PR 级范围历史。

`set_review_scope` 是范围的唯一持久化入口。调查前写入 `kind`、`mode`、具体 `targets`、`comparison_start`/`comparison_end`、继承的 run、原文范围和判断依据；每个 batch 完成及失败前更新 `$REVIEW_WORKSPACE_PATH/review-coverage.json`。`scope_id` 必须进入最终 JSON 并匹配 manifest。失败只保留 `failed`/`draft` 和已完成 batch；局部成功不推进完整 `audit` checkpoint，`published` 只由可信 publisher 的完成 Check 事实写入。
例如 A batch 成功、B batch 失败、随后 C 发生变化时，历史 coverage 必须保留 B 未完成，下一次 PR 级请求重开 B 并调查 C 的新增变化和直接影响；不能只沿用 A，也不能用 C 的成功覆盖 B。

普通 PR 请求若提供 `$REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH`，先只读读取最近 PR 级 artifact 的 request/coverage manifest，再继承实际范围并重开未完成 batch；该历史按控制仓库 artifact 的 repository ID、PR、source、run、attempt 查找，不依赖 ancestor/base 关系，排除 thread 和当前运行，可包含失败、草稿或发布未完成工作稿。找不到、artifact 过期和查询接口错误必须分别记录，不能把它们合并为“无历史”并改变范围。`$REVIEW_PREVIOUS_WORKSPACE_PATH` 只表示成功完整 audit 的独立 checkpoint 参考，不能代替请求历史。

## 1. 读取项目规则

`$REVIEW_INPUT_PATH` 已包含 merge base 与 head 中存在的 `.agentic-review.md` 和 `AGENTS.md`。按 head 理解预期合并后的项目规则，并把 base/head 差异作为当前变化的一部分。

不自动枚举 Target Skill；按 head 的 `.agentic-review.md` 为当前变化显式给出的文件路径读取相关项目上下文。

完成条件：工作稿记录采用的项目规则、base/head 规则差异，以及实际读取的显式引用文件与用途。

## 2. 获取当前 PR 元数据

`$REVIEW_INPUT_PATH` 已包含 PR 元数据、commit、普通评论、Review 和 inline comments，不重复查询。需要判断当前 PR thread 状态时，用 `gh api graphql` 读取 `reviewThreads` 的 `isResolved`、`isOutdated`、`resolvedBy` 和完整 comments，并用首条评论的 `databaseId` 对应 root comment。

完成条件：当前 PR 元数据和全部讨论已读取一次，工作稿记录显式关联线索和当前 thread 状态。

## 3. 读取历史结果和代码差分

`$REVIEW_PREVIOUS_WORKSPACE_PATH` 非空时，按 `workspace.md` 接入 checkpoint 对应的只读工作稿；先用最新 PR 讨论、thread 状态和增量 diff 更新前提，再判定继承或重开。它不覆盖本轮请求 scope，也不把一个 thread 任务扩展为 PR 范围历史。

输入包含 full diff 及存在时的 focus diff。full diff 始终是上下文和 inline 证据的来源；scope 决定本轮 ledger 的覆盖边界。无请求历史时按本轮请求决定 full/incremental/focused；有历史时优先调查 focus diff，从 full diff 覆盖文件清单、受增量影响或历史未完成的 hunk 及 finding 位置，其余按继承条件复用。`$REVIEW_MODE`：

- `initial`：没有可用 checkpoint；
- `incremental_all`：完整 diff 都在 checkpoint 之后；
- `incremental`：focus diff 是 checkpoint 到当前 head 的净变化；
- `incremental_unchanged`：该区间没有净代码变化。

finding 的差分证据与评论行号只能来自 full diff，绑定最接近根因的 RIGHT-side 行；focus diff、scope 外的上下文和历史笔记不替代它。限定 scope 内的调查可以读取直接影响的上下文，但只能报告 scope 内结论；full diff 没有对应代码位置时不生成 inline comment。按需从 `$REVIEW_TARGET_PATH`、`$REVIEW_BASE_PATH` 补充文件上下文，不重复读取或生成已有 diff。

完成条件：checkpoint 后且属于本轮 scope 的变化及其影响面已经调查，最新讨论已归类；完整 diff 的文件和 hunk 可登记到 ledger 以标记本轮覆盖、scope 外或待覆盖，登记本身不等于完成审查，历史继承仍须满足 `workspace.md` 条件。

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
