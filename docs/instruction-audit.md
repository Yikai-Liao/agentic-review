# Agent 指令审计记录

本记录供维护者复核，不加入默认 Prompt 或 AGENTS 必读路径。

**历史版本说明**：下文保留 2026-09-07 及后续注明日期的审计事实，旧文件名和加载数量不是通用化实验的当前操作指令。当前结构、中央默认范围与验证边界见 [通用化实验](generalized-review.md)；本记录不证明新版本通过了同一审计。

## 基线与范围

- 审计日期：2026-09-07；已执行 `git fetch origin`，开发基线与 `origin/main` 均为 `c92711e6bbebbfd874bc17fcb3d4f6a6f7b779e5`。
- 行为基线：[GPT-6 Astra 当前提示指南](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)。采用其明确用户与 Skill 优先级、减少非必要停顿、按风险验证的建议；没有把示例中的委派策略变成仓库义务。
- 加载机制核对：[Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)、[Codex Skills](https://developers.openai.com/codex/skills)。本机配置选择 `gpt-6-astra`、`high`，仓库没有独立 Codex 配置。
- 检查了仓库及父目录的 AGENTS/override、仓库两个 Skill 及全部引用、中央入口/适配器、workflow、工具描述、README/部署文档和相关历史实现。
- 本机全局 `~/.codex/AGENTS.md` 与 `instructions.md` 为空；未发现适用 override。会话注入的系统、开发者、权限及记忆使用规则由宿主管理，本次不复制进仓库。
- 检查了本会话所有可用外部 Skill 的描述与入口；未递归加载图片、PDF、插件等未触发工作流的引用。其他 worktree、禁用 Skill 和插件缓存中的未暴露文件不等于本仓库已加载指令。

## 修改前的有效层级

本地维护：宿主系统/开发者与权限规则 → 用户任务及仓库 AGENTS → 按任务选择的 Skill → 条件引用。仓库 `.agents/skills/writing-for-agents` 可被发现；`skills/agentic-review` 是发布源，不因普通代码维护自动执行。

中央 Review 是另一运行时：workflow 固定工具、token、模型和控制面 checkout → Action 系统提示 → 预载入口、公共 Skill、三个核心引用及两个中央适配器 → PR 输入 → 按触发补充证据。目标 AGENTS、`.agentic-review.md` 及其引用是审查材料，不能替换控制面规则。PR 回复的业务确认效力不授予运行权限。

核对了固定版本 [shaftoe Action 的系统提示](https://github.com/shaftoe/pi-coding-agent-action/blob/v2.27.1/packages/pi-orchestrator/src/pi/prompt.ts) 和 [资源加载器](https://github.com/shaftoe/pi-coding-agent-action/blob/v2.27.1/packages/pi-orchestrator/src/pi/resource-loader.ts)：其默认提示说明非交互运行、避免前言和重复 footer；builtin GitHub 工具及其指令在当前 workflow 中关闭。Action 的默认评论描述不能代替本仓库的 `submit_review`/publisher 协议。此结论来自固定版本源码与本地 workflow，不是线上运行验证。

## 分类与处置

按行为语义分类，合并同义句；编号沿用任务定义：①项目事实/不变量，②安全/授权，③专项工作流，④确定性工具职责，⑤模型脚手架，⑥重复，⑦歧义/冲突，⑧过期，⑨证据不足。

| 原指令或语义组 | 分类 | 依据与处置 |
|---|---|---|
| 唯一生产路径、事实来源、低开销、易维护、不保留 legacy | ①⑥ | 明确产品约束；合并目标与维护者条款，不扩大兼容义务。 |
| 根因修复、不伪装成功、不凭空增加防御和降级 | ①②⑥ | 保留实际故障/明确需求准入；保留 fail-closed、校验与数据保护。 |
| workflow 编排、业务逻辑放可测试代码 | ① | 保留，不能由现有内联脚本反推这是无效要求。 |
| Review shell 只读、隔离 publisher、开发会话可正常 Git 写入 | ①② | 保留角色、时间与 token 范围；历史权限修复见 `7a089ac`、`4c999ee`。 |
| 固定同 owner App 安装仓库集合、引用可选私有记录 | ①② | 保留无须 merge-base 预授权及关联不证明授权/验收；依据 `d90c16a`、`30e8385`。 |
| PR 明确回复即时确认、不核验作者/association | ①②⑥ | 保留产品决定；中央重复条款归入公共 Skill，依据 `8013f89`。维护 AGENTS 另述此不变量，不能用目标输入替代可信运行时规则。 |
| Actions 必须使用明确发布版本号 | ① | 移至 `.github/AGENTS.md`；`.agentic-review.md` 加条件指针，保证中央静态 Review 也能发现。 |
| 质疑变更时先解释、明确撤回则执行 | ①⑦ | 保留两种意图的区别，缩短措辞，不增加批准阶段。 |
| 开发期不用 subagent 做代码 Review | ② | 保留；公共 Skill 的可选委派不能覆盖本仓库禁令。 |
| 新脚本 TypeScript，修改 JavaScript 一并迁移 | ① | 保留；未为本次指令整理改动无关脚本或保留兼容包装。 |
| 中文 PR/Issue、标识符和第三方引文例外 | ① | 保留并按用户补充覆盖 AGENTS、Skill 和文档。 |
| synthetic merge candidate Engine 安装并执行 | ⑧ | `4b5714b` 已删除该实现；移除运行方式描述，保留可信维护者模型及当前静态输入边界。 |
| 写作 Skill 的上下文指针、单一来源、渐进披露 | ③ | 有专业价值；本 PR 保留该 Skill 原状。 |
| 写作 Skill 的固定过程、最强穷尽标准、隐喻压缩与强化词 | ⑤⑦⑨ | 无本仓库效果证据，且可能改变验证和编排强度；列为待改进项，本 PR 未修改。 |
| 为隐藏后续步骤而切换上下文、拆 Skill 或 router | ⑤⑦ | 可能产生多余编排；本 PR 未修改写作 Skill 的通用处方。 |
| `disable-model-invocation`、用户调用 Skill 不能被其他 Skill 读取 | ⑦⑧ | 与 Codex 调用机制不符；本 PR 未修改该来源，实际调用服从宿主规则。 |
| 写作 Skill 的上游安装锁 | ④ | 继续跟踪原上游 Skill，保留 `skills-lock.json`。 |
| Review 的静态执行、输入信任与调用方范围 | ②③⑥ | 统一入口声明；描述排除普通维护任务，用户范围/输出要求不扩大运行权限。 |
| 每轮完整加载三份核心规则 | ①③ | 保留；`e287382` 修复规则加载，`1023646` 预载，`08d5540` 恢复 Skill 发现。只删除重读和重述。 |
| worker 模式、单层委派、单写者 | ②③ | worker 细节移到条件引用；入口保留授权、工具及独立 batch 触发，写入边界归 `workspace.md`。 |
| working tree/commit/ref 默认范围、干净目录需用户给范围 | ③ | 保留原文；这是会改变审查对象的决定，不靠猜测消除询问。 |
| Git 管理目录 mktemp、清理和中断保留 | ②③④ | 保留短命令与生命周期；没有重复复杂操作需要新增脚本。删除命令效果的重复解释。 |
| ledger、census、complete batch、增量继承与重开 | ①③⑥ | 保留覆盖与继承判据；将重复完成条件归入工作稿和专项证明，依据 `fa250cf`、`4f6e24f`。 |
| 生产候选五道门槛、诊断观察者、错误恢复语义 | ①③ | 保留全部判据及诊断不能被相同最终状态反证的例外；删重复风格说明和最终检查表。 |
| 性能成本模型、六类准入、语义等价替代与反证 | ③⑨ | 除中文标题外保留；未证明阈值和反例可删除。复杂度不能自行决定严重度。 |
| T1/T2、fingerprint、路由、veto、deletion/witness | ①③⑥ | 保留逐项覆盖及全部分支判据；压缩重复说明和末尾字段复述。 |
| 测试 boundary、mock 责任、禁止臆造 hard-code witness | ①③⑨ | 保留具体例外和区分性示例；没有行为等价证据支持进一步泛化。 |
| known issue 原文、关联、状态和当前处理 | ②③⑥ | 保留来源权限及摘要只导航；状态确认复用入口。修正入口遗漏受信任本地记忆的重叠限制，以 `evidence.md` 为查询入口来源。 |
| P/T 严重度、人工确认、根因去重与位置 | ③⑥ | 保留专项门槛、互斥、最小位置；删除重复自检和已由专项定义的输出示例。 |
| 中央 full/focus diff、RIGHT 行号、thread 状态 | ①②③ | 保留完整 diff 的唯一差分地位、每轮状态更新和确认范围；压缩历史工作稿复述。 |
| 中央格式模板与公共模板 | ③⑥ | 公共 `findings.md` 为唯一模板，中央适配器明确其必需性并保留自身 JSON 协议。 |
| 写 JSON 后再运行 jq | ④⑥ | `submit_review` 已执行 `JSON.parse`，publisher 已做 schema 校验；删除重复工具调用，保留大小、路径、封存及发布边界。 |
| 发生过 compact 就重新读全部相关材料 | ⑦ | 改为规则缺失或无法准确恢复时重读；已恢复材料不因历史事件重复加载。 |
| `.agentic-review.md` 重述中央规则、“已覆盖根因不报告” | ⑥⑦ | 改为项目路径指针和审查重点；中央有规则不等于某个 bug 已被处理。 |
| README App 权限、部署文档保留一天、未来 Lark 接入 | ⑥⑧ | App 安装权限指向部署权威说明；保留期指向 workflow；删除尚未实现的未来接入指令。 |
| 工具 schema、路径/大小、只封存一次和可信 publisher 校验 | ②④ | 保留实现，工具描述改中文；不另写提示校验器或新增运行路径。 |

## 外部与宿主指令

这些来源不属于本仓库维护文件，未改写共享安装或在本地复制一套覆盖规则。

| 来源 | 激活边界与判断 |
|---|---|
| `openai-docs` | OpenAI 产品、模型和提示工作；当前任务适用。来源核验属③；其固定先查文档与宿主先看本地的顺序有冲突，按宿主优先，不转成用户确认。 |
| `skill-creator` | 创建或修改 Skill；当前任务适用。命名/元数据校验属③④，验证可按改动规模执行，没有自动要求独立 subagent。 |
| `software-design-philosophy` | 软件架构、模块和接口设计；本次指令审计不触发。全方法加载和调试面询问可能增加负担，但属共享专项要求，缺少其任务验证证据（⑨），未改动。 |
| `imagegen` | 位图生成和编辑；不用于 SVG/代码原生图形。本次不触发；输入、产物、CLI 授权属②③。 |
| `pdf:pdf` | PDF 内容、表单及版面；本次无 PDF，不触发。表单逻辑/外观双重验证属③④，不借普通“文档”字样启动。 |
| `plugin-creator` | 插件 manifest、市场及安装更新；本次不创建插件，不触发。工作流和校验属③④，固定手册/格式条款不复制进仓库。 |
| `skill-installer` | 列举可安装 Skill 或安装；本次编辑已有 Skill 不触发。沙箱网络一律升级的措辞与当前无审批配置不符（⑦），以实际宿主权限为准。 |
| 宿主指令、工具协议及记忆规则 | 当前会话直接加载，优先级高于仓库；不通过仓库文件尝试删除。当前任务未用历史记忆作为项目事实来源。 |

## 结果层级与激活边界

- 根 `AGENTS.md`：仓库地图、实现约束、信任不变量、协作与中文约定。
- `.github/AGENTS.md`：仅 GitHub 配置版本约束；中央 Review 通过 `.agentic-review.md` 的条件指针读取。
- `writing-for-agents`：保留原描述，创建或编辑 Skill、AGENTS.md、CLAUDE.md 时触发；编写 Skill 时读取机制文件。其过宽表达和调用机制问题仍是上述待改进项。
- `agentic-review`：明确的静态 Review 任务；维护实现不会自动启动。核心 `workspace/evidence/findings` 保持完整预载，专项按变化触发，委派协议仅在获准委派或已分配 worker 时读取。
- `prompts/review-rules.md`：中央入口与输入读取；信任规则在公共 Skill。
- `central/github-context.md`：GitHub 证据入口及查询范围；`central/review-result.md`：thread、JSON 和唯一提交。
- README/部署文档/本记录：维护者按需资料，不新增默认加载义务。

安全约束在维护 AGENTS 与可信运行时入口各有表达是有意的：前者约束维护，后者在另一运行时执行，不能用目标 PR 中的 AGENTS 替代可信规则。

## 代表任务验收

以下是逐项语义走查，不是模型 A/B 基准，也不宣称测得实际延迟或 finding 质量提升。

后续变更（2026-09-10，[PR #67](https://github.com/Qiyin-Tech/agentic-review/pull/67)）：关联记录的读取时机已扩展到契约恢复阶段，当时规则见 [固定版本 evidence.md 第 5 节](https://github.com/Qiyin-Tech/agentic-review/blob/3bc3cc07c8966657799ec251af9b6acc9ff3acf2/skills/agentic-review/references/evidence.md#5-按需读取外部契约与-known-issue)。下表保留 2026-09-07 的审计结论。

| 任务 | 修改后的关键决策 |
|---|---|
| 修正 README 错字 | 不触发 Review/架构 Skill；未改写的写作 Skill 是否误触发仍受其原描述影响。根 AGENTS 不要求全量测试、计划或委派。 |
| 修改 webhook delivery 去重 | 维护代码并验证受影响行为，保留失败释放 claim；Review 的禁止执行规则不误约束本地开发。 |
| 调整 workflow token | 读取 `.github/AGENTS.md`，核对版本与实际权限；发布器需求不扩大 Agent token。 |
| 审查本地未提交变化 | 纳入 staged、unstaged、删除及 untracked；工作稿在 Git 管理目录，不污染 diff。 |
| 干净目录且未给 Review 范围 | 仍询问具体范围，避免审错对象。 |
| 中央增量 Review 及发生 compaction | full diff 文件和 hunk 都有覆盖状态，可区分本轮 scope、scope 外和待覆盖；仅前提不变的 complete batch 可继承，无法恢复规则时重载。 |
| PR 回复接受当前边界变化 | 明确回复即时生效，不查作者/association，不重复要求确认；超出接受范围才重开。 |
| 引用同 owner 私有 Issue | 候选成立后按固定集合只读，允许 merge base 未声明的引用；不扩张 token 或按主题泛搜。 |
| 测试内部值重复 vs 新增明确边界 | 保留 census/fingerprint、独立边界 veto 和真实 witness 区分，不凭样本不同或虚构硬编码判价值。 |
| 改动分页、并发或远程往返 | 才加载性能专项；成本、现实规模与替代机制须有静态证据，不运行目标 benchmark。 |
| 只给更多工具，没有委派授权 | 顺序完成；本仓库开发期独立代码 Review 仍交自动流程。 |
| 生成中央结果 | 使用公共 finding 模板及中央 JSON，唯一封存，可信 publisher 写入；不额外跑 jq。 |
| 仅请求本地修改，后续可能部署 | 完成本地结果；真正需要未授权外部写入时再请求批准，不因 Skill 建议提前停顿。 |

## 验证与规模

- 修改的 `agentic-review` Skill 通过 `quick_validate.py`；本地 Markdown 链接检查无断链。
- `pnpm exec tsx --test test/review-tools.test.ts`：9 项通过，覆盖封存、越界拒绝、schema、thread、summary-only 和发布 head；未新增镜像测试或启动 subagent。
- `git diff --check` 通过。未改变 workflow、token、API/provider 配置或发布器执行逻辑，未执行线上发布。

字符规模使用 Unicode 码点，含 Markdown 标记；不是 token 计数，英文转中文的部分尤其不能直接换算 token 收益。

| 加载范围 | 修改前 | 修改后 | 减少 |
|---|---:|---:|---:|
| 根 AGENTS | 2,324 | 1,569 | 32.5% |
| 中央首次固定预载的七个文件 | 18,853 | 14,128 | 25.1% |
| 测试契约专项 | 8,513 | 7,262 | 14.7% |

未删除但需留意：现有 workflow 仍有浮动 major Action 引用，不符合维护者要求；这不证明要求过期，本次没有混入依赖升级。核心工作稿、性能阈值、测试证明粒度和维护者质疑处理的进一步删减缺少行为等价证据，保留精度。
