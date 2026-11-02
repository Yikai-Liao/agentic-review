# 周末中央 Review 耗时与本轮优化

分析日期：2026-11-02。周末按 UTC+8 的 10 月 31 日至 11 月 1 日计算，主 workflow 共 8 次运行，全部成功，控制面均为 `bc307bbe19ddd9de4fd44e065b3fb7c25c78d645`。本轮在该版本上完成本地修改与验证，尚未取得新版本的线上端到端时间。逐次记录、查询计时与输入验证见[统计数据](2026-11-02-weekend-review-latency-data.json)。

## 周末基线

实际模型为 `openai/gpt-6.1-sol`、`high`，8 次 `REVIEW_FAST_MODE` 均为 `false`。飞书暂停、增量继承、输入预载和单 job 发布已经上线，不能再把它们列为待实施优化。

| 运行 | 审查文件／本轮 pending | 总耗时 | Run Pi review | 模型回合 |
| --- | ---: | ---: | ---: | ---: |
| [前端 #461 首审](https://github.com/Qiyin-Tech/agentic-review/actions/runs/41162730657) | 16／16 | 2 分 14 秒 | 1 分 42 秒 | 17 |
| [前端 #461 复审](https://github.com/Qiyin-Tech/agentic-review/actions/runs/41163216395) | 17／3 | 1 分 23 秒 | 39 秒 | 9 |
| [前端 #462](https://github.com/Qiyin-Tech/agentic-review/actions/runs/41171466680) | 8／8 | 1 分 48 秒 | 1 分 15 秒 | 17 |
| [前端 #463](https://github.com/Qiyin-Tech/agentic-review/actions/runs/41186253360) | 3／3 | 1 分 26 秒 | 51 秒 | 16 |
| [前端 #464 首审](https://github.com/Qiyin-Tech/agentic-review/actions/runs/41186858453) | 11／11 | 2 分 9 秒 | 1 分 36 秒 | 18 |
| [前端 #464 复审](https://github.com/Qiyin-Tech/agentic-review/actions/runs/41187399725) | 12／2 | 1 分 43 秒 | 1 分钟 | 13 |
| [后端 #886](https://github.com/Qiyin-Tech/agentic-review/actions/runs/41199690681) | 1／1 | 1 分 6 秒 | 36 秒 | 11 |
| [后端 #887](https://github.com/Qiyin-Tech/agentic-review/actions/runs/41267584329) | 15／15 | 1 分 38 秒 | 53 秒 | 12 |

| 指标 | 中位数 | 范围 |
| --- | ---: | ---: |
| workflow 总耗时 | 100.5 秒 | 66–134 秒 |
| 模型步骤 | 56.5 秒 | 36–102 秒 |
| 创建至首个 job 启动 | 4 秒 | 3–5 秒 |
| job 启动至模型步骤开始 | 18.5 秒 | 16–24 秒 |
| 模型步骤结束至 workflow 结束 | 12.5 秒 | 10–18 秒 |
| 每次运行的准备与收尾合计 | 31 秒 | 26–41 秒 |

各行分别计算中位数。总耗时使用 workflow `created_at → updated_at`，排队近似值包含 runner 调度，收尾包含发布、归档及 post step。8 次累计模型步骤 512 秒，占总耗时 807 秒的 63.4%。工具启动至结束区间累计约 11.5 秒，约为模型步骤的 2.2%；其余时间包含模型调用、生成和运行时开销。

## 已实施：减少模型往返

启动时仍反复加载默认 code 规则。8 次运行的前两轮合计约 4.3–5.6 秒，主要用于读取规则，部分混合工作稿或项目指令；不是规则文件的本地 I/O 耗时。两次复审还分轮读取笔记、文件进度和上一轮结果。后端 #886 在刷新讨论后分别用一轮修改笔记、一轮修改进度，再提交结果。

本轮沿用现有预载与工具能力：

- 固定可信 Prompt 预载 code 层及行为、意图对齐、安全、可靠性和性能方法；采用 code 时直接使用。其他层级、测试方法和关联问题规则仍按实际职责加载，预载不改变层级选择和触发条件。
- 将当前笔记、文件进度和已有上一轮结果加入现有材料索引及预载候选。预算不足时继续保留原文路径。
- 根据审查清单补齐变化路径祖先目录中的 `AGENTS.md`，保留 base/head 差异；扩展调查到其他目录时继续按需读取。
- 同一阶段需要更新笔记与进度时，使用一次现有 `bash` 或 `codemode` 调用；完成判断仍由 Agent 作出，未自动标记覆盖完成。

使用周末固定 SHA 和历史工作稿，验证了前端 #461 的 3 文件增量、后端 #886 的 1 文件首审和 #887 的 15 文件首审。三组均交付目录指令、笔记与进度；复审还预载上一轮结果，pending 仍为 3，保持历史完成项继承。固定 Prompt 为约 27.3K Token，三组材料实际注入约 6.4K–21.6K Token，处于 500K 窗口的现有启动预算内。此验证没有运行模型，实际回合减少量仍需新版本运行确认。

## 已实施：减少准备和发布开销

`review-execution.yml` 从 36 个配置步骤减至 18 个。准备与发布分别由一个 TypeScript 入口承担完整操作，workflow 保留权限签发、运行环境、Agent 执行、归档和 Check 编排：

1. `prepare-review-context.ts` 统一下载固定代码、恢复历史工作区、持久化范围、生成输入和装配 Prompt。目标仓库只获取固定 base/head 及其历史，base 共用已有 Git 对象创建独立 worktree。显式请求的历史范围属于另一条提交历史时，按已验证记录补取缺失 SHA；下载使用只读 `GH_TOKEN` 和临时 Git credential helper，不持久化凭据，创建工作树禁用 checkout hook。
2. 讨论读取与 Git 下载并行，关联索引、历史 checkpoint 恢复和 base 工作树准备并行。PR 元数据复用首次快照查询的原文，提交列表取自固定区间的本地 Git，移除重复的 `gh pr view`。可信脚本复用 `actions/github-script` 自带的 Node 24，移除独立 Node 安装步骤。
3. 请求上下文以本地内容和可信步骤输出中的 SHA-256 摘要绑定，替代同 job 内的 artifact 上传与下载。发布器先验证摘要，再解析同一份内容、核对 workflow 输入和覆盖清单。摘要缺失、内容变化均失败；发布前仍重新 checkout 固定 ref 的可信脚本。
4. `publish-review-run.ts` 统一校验、组装、发布和保存报告，正常路径的 artifact 上传从 3 次降为 1 次。发布成功归档完成工作区；发布失败、Agent 失败或已组装后的取消归档可恢复工作区，包含发布报告。准备入口写出请求摘要后，即使后续输入准备失败，也能保存已固定的范围。归档失败仍阻断 Check 成功，原始诊断稿不进入范围恢复。

步骤输出由 Runner 在步骤结束时处理并保存；后续 Agent 步骤不能通过自己的输出替换准备步骤的值。依据 GitHub 的[步骤输出说明](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#setting-an-output-parameter)和 [Runner 输出处理实现](https://github.com/actions/runner/blob/main/src/Runner.Worker/FileCommandManager.cs)。本地文件只读权限不承担完整性边界。

对完整准备流程额外做了只读对照：基线复现周末版本的目标/base checkout、关联索引、历史恢复、范围持久化和输入准备顺序，候选直接运行新的生产准备入口。两侧固定相同 SHA，Git 下载使用同一个本地镜像，GitHub 查询与历史制品下载访问线上；每组交替顺序执行 3 对。计时从代码下载开始，至输入和 Prompt 装配结束，不包括快照解析、依赖缓存、Actions 步骤调度或模型执行。

| 准备场景 | 基线中位数 | 候选中位数 | 减少 |
| --- | ---: | ---: | ---: |
| 后端 #886，1 文件首次准备 | 4.714 秒 | 1.837 秒 | 61.0% |
| 后端 #887，15 文件首次准备 | 4.281 秒 | 1.960 秒 | 54.2% |
| 前端 #461，恢复已完成的固定快照 | 7.280 秒 | 4.269 秒 | 41.4% |

两侧文件清单与 pending 数一致，分别为 1／1、15／15、17／0。最后一组按测量时已存在的完成记录恢复当前固定快照，因此 pending 为 0；前文启动材料验证使用周末复审前的历史工作稿，pending 为 3，两者验证对象不同。候选源码摘要与计时记录一致。此结果反映本机准备逻辑及线上只读查询的耗时，不代表 GitHub runner 下载速度或线上端到端净收益。此前单独隔离关联索引/checkpoint 查询的串行与并行对照，也保留在统计数据中。

## 验证与待测量项

`pnpm check` 通过，`pnpm test` 共 154 项全部通过。覆盖 automatic、PR 评论和 thread 三类请求的完整准备入口、另一条历史中的范围补取、元数据复用、讨论读取失败后的范围留存、错误 checkpoint 拒绝接入、请求默认范围被改写时拒绝发布、摘要缺失、完整覆盖校验、只读 Agent 与独立发布 token、发布及归档失败、取消时归档、已有对象复用和 checkout hook 不执行。

本轮未改变模型、推理档位或 fast mode，也未运行 Darwin。后续线上比较应分别记录首审和复审的模型回合、模型步骤、准备与收尾时间；在新版本运行前，不宣称总耗时已从 100.5 秒降到某个值。
