# agentic-review 通用化实验

目标是在同一仓库、同一 skill 名称下，让 Review 支持从需求、架构、开发计划到代码的全过程，而不是长期维护第二个产品。各层帮助理解、传递和完善用户目标，并通过按需组合的审查视角支持高效、优雅、可维护的实现；共同使用证据、结论和复核方法。中央服务仍只承担代码审查职责。**可以检出试用不等于可以切换生产，也不等于模型行为已证明不退化。**

## 方法与调用方的边界

| 位置 | 负责什么 |
|---|---|
| [Skill 入口](../skills/agentic-review/SKILL.md) | 解释方法目的、纵向层级与横向视角的关系，引导选择范围、完成审查并接回开发 |
| `references/protocol.md` | 固定版本和范围，建立依据、调查与反证，反查覆盖并说明取证缺口 |
| `references/findings.md` | 区分结论性质，核实证据，去重并说明处理完成条件 |
| `references/review-state.md` | 管理记录、进度、问题状态和交付条件，处理证据继承、修复、恢复及可选委派 |
| `references/evidence-access.md` | 默认只读推演；明确授权后如何隔离实验，以及如何核实实测证据 |
| `references/levels/`、`references/focuses/` | 各层定义对象与当前阶段要求，横向视角提供调查方法；不要求执行所有组合 |
| `assets/review-record.md` | 提供记录提示，复用上述方法与状态定义 |
| [中央入口](../prompts/review-rules.md) | 选择 code，展开六项默认调查及触发条件，不重新定义判断标准 |
| [中央结果协议](../central/review-result.md) | 固定工作稿布局、正文/inline 排版、JSON、thread 和提交终点 |

中央六项默认职责为：行为与意图对齐、安全边界、可靠性与恢复、性能与资源成本、测试有效性、测试经济性。测试经济性不以请求 simplify 为前提。详细触发与引用直接写在中央 prompt，不要求 Reviewer 猜测“原来的默认是什么”。

中央不自动增加需求/架构/计划审查、可维护性专项或验证充分性审计。上层材料可用于恢复代码契约，但不会因此扩大审查对象。现有 automatic/pr_comment/thread 的完整范围、显式窄审与增量复核规则仍由中央适配器承担；“重点看”不等于“只审”。

## 旧规则的去向

比较基线为 `3bc3cc07c8966657799ec251af9b6acc9ff3acf2`，完整旧文本由 Git 保留，不在新 skill 内保留第二套运行入口。

| 基线文件 | 当前归属 |
|---|---|
| `SKILL.md` | 通用入口、code 层和中央 prompt 的显式调用范围 |
| `workspace.md` | 共享 review-state/evidence-access；中央布局、完整提交门槛及归纳读取规则在 central/review-result |
| `delegation.md` | review-state：授权、已有工具、至少两个独立 batch、单层委派与单写者；子任务不查询私有记忆 |
| `target-selection.md` | levels/code/target-selection，保留本地范围及重命名/复制两端路径 |
| `known-issues.md` | 按需保留为关联记录处理入口：原文、因果关联、内容分类与当前 Review 去重；关闭证据引用 review-state，最终披露引用 findings，平台查询边界仍在中央适配器 |
| `evidence.md` | protocol、findings、levels/code/behavior；代码现实路径与生产影响证明不以通用口号替代 |
| `performance.md` | focuses/performance，保留代码成本证明，并扩展需求目标、架构容量和计划验证的跨层方法 |
| `test-contracts.md` | levels/code/test-contracts，保留 census/fingerprint、违反/允许探针、独立价值与删除证明 |
| `findings.md` | 共享成立/去重/历史披露、code 的 P/T 特化；中央正文和 Alert/inline 模板完整迁到 central/review-result |

`[agentic-review-worker]` 不再是必须识别的入口字符串。委派任务须明确“只调查指定 batch”、固定版本、证据、规则和输出边界；该改变不授予额外权限，不开放递归委派。当前中央 workflow 不加载 delegation 工具，不为本实验引入多 Agent 运行时。

独立依据不再单纯要求时间早于变更：代码/测试不能互相自证，但按调用方来源规则生效的即时业务决定可以改变预期。业务确认不能升级执行/发布权限。原代码门槛中的私有记忆限制、项目 `.agentic-review.md`、复制两端、可信输出恢复及提交前刷新已明确归属，而非默认为无需保留。

## 有意改变和不改变的部分

- 本地支持四层和额外专项，不默认强制加载全部规则或创建中央式多文件工作稿。调用方可使用通用结论，不限于代码 P/T；不能把新性质冒充旧标签。
- 通用方法默认静态。隔离实验仅在调用方明确授权且环境边界成立时可执行；**中央服务仍禁止运行目标代码、安装依赖、修复或直接发布**。
- 新 code 方法使用同一套证据与状态协议，不再调用旧完整入口。原生产行为和测试证明以及高风险确认要求由 code 特化承接，性能证明由横向性能视角在代码层承接。
- 中央工作稿仍是 `notes.md`、`batches/` 和固定结果文件；完整 scope 覆盖、最新讨论、状态判断及唯一提交不因通用层允许报告部分调查而放宽。
- 发布器、JSON schema、token 权限、GitHub thread 操作、部署路由不因本实验增加新分支或新权限。中央外的专项若需要新输出能力，应单独完成其接入，不静默挤入 P/T。

## 验证与试用

在本分支隔离 checkout 中执行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

`review-instructions.test.ts` 检查真实 prompt 组装、恢复路径、安装包引用、迁移后的文档链接与中央示例 JSON；现有范围、工作稿、提交和发布测试继续使用。它们不是模型执行测试，不证明模型一定按文本调查。

行为材料见 [通用化案例](../evals/generalized-review/README.md)。历史准备阶段曾对改名和后续修正前的固定快照运行 Luna high 14 例，作者评分全部通过；其余 47 例未运行。原始运行产物不随本分支迁入，该历史结论不能冒充当前分支的评测结果。表达评测继续使用 [现有流程](../evals/README.md)，不拿表达胜出替代代码准确性。

合入 main 前，还需要固定两个控制面版本，用相同模型/档位、工具、PR 输入、base/head 与历史比较真实代码场景和正反例：正确发现、漏查、误报、类型与重复、完整/局部覆盖、历史继承/重开、修复关闭，以及阅读/工具/token 成本。分别使用各自完整中央入口，不混用新旧 reference。对默认范围、安全或输出契约的非预期差异应先修复；新增层级的收益不能抵扣代码退化。

试用时复制当前分支 skill 到隔离宿主，保持默认部署安装指向 main。不要仅因本分支存在就修改 Dispatcher 的 workflow ref 或触发生产 Review；上线与外部发布需维护者单独决定。本实验不改变原仓库的内部可见性或内容许可。
