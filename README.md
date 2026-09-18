# agentic-review

可复用的独立 Review Skill 与中央 PR Review 控制面。本实验版纵向支持需求、架构、开发计划和代码，横向按需组合意图对齐、可维护性、可靠性、安全和验证等视角，共用证据、结论与复核方法；skill 名称仍为 `agentic-review`。中央服务固定执行静态代码审查，不因能力泛化自动审查整份需求、架构或计划，也不向下游保存模型或 GitHub 凭证。

这是准备合入 main 的通用化实验，不是已经证明行为无损的生产替换。结构、接入检查与模型效果分别验收；范围、迁移决定及剩余验证见 [通用化实验](docs/generalized-review.md)。

## 运行链路

```text
GitHub pull_request webhook
  -> Cloudflare Worker（验签、过滤、去重）
  -> 中央仓库 workflow_dispatch
  -> 三个短期 installation token
       ├─ read：给 Pi、Action 和只读 gh
       ├─ check：在 Pi 启动前创建关联 Check，不传给 Agent
       └─ publication：只给隔离的可信发布 job
  -> Pi 按可信 agentic-review Skill 审查，并在隔离工作区维护工作稿
  -> submit_review 封存最终 review-result.json
  -> 可信发布器创建一个完整 Review、更新历史 thread，并链接工作稿 artifact
```

中央 workflow 使用 [`shaftoe/pi-coding-agent-action`](https://github.com/shaftoe/pi-coding-agent-action)，不维护自研 Pi SDK、multi-agent 或 aggregator。[中央入口](prompts/review-rules.md) 选择 code 层，明确行为与意图对齐、安全边界、可靠性与恢复、性能与资源成本、测试有效性、测试经济性的默认调查及触发条件；不承载另一套判断门槛。Review 方法论位于 `skills/agentic-review/`；入口、共享规则、code 入口及中央适配器首次预载，具体特化按触发加载，compaction 后从控制面恢复。`central/` 接入 GitHub 上下文、工作稿及可信发布格式。下游项目事实放在 `.agentic-review.md`；关联索引供契约恢复或候选复核时按需读取原始记录，不加载全量历史。

Review 方法和表达按 [Darwin 迭代流程](evals/README.md)演进：固定用例、新旧版独立生成、三评委匿名成对比较、长度与事实回归后才保留。Git 只维护工具、用例和精简结果；运行产物在 `evals/experiments/` 本地留存并忽略，不进入生产 Review，也不代替缺陷准确率评测。

## 本地安装与使用

安装 main 发布版本时，在目标项目根目录执行：

```bash
npx skills add Qiyin-Tech/agentic-review --skill agentic-review --yes
```

试用本实验分支时，在隔离项目中复制当前 checkout 的整个 `skills/agentic-review/` 到 `.agents/skills/agentic-review/`，再显式调用 `$agentic-review`。不要把上面的默认安装命令当成已选中实验分支；不要覆盖生产宿主或同时加载两份同名 skill。

本地可以审查未提交变化、指定 commit、分支差异，也可以明确选择需求、架构或计划。只审查已有产物，不直接创作或修复。例如：

```text
$agentic-review 审查当前未提交代码，覆盖行为、性能及测试契约；只读，不修复。
$agentic-review 审查 docs/requirements.md 的目标、范围与验收，以 docs/request.md 为原始依据。
$agentic-review 审查 docs/architecture.md 的状态、失败与恢复责任，不审查实现风格。
$agentic-review 审查 docs/plan.md 的依赖、迁移中间态和集成验收责任。
```

方法哲学、层级与视角的选择，以及 simplify/harden 的适用方法见 [Skill 入口](skills/agentic-review/SKILL.md)。本地工作稿复用调用方路径（如 `REVIEW_WORKSPACE_PATH`）；未提供时在 Git 管理目录或系统临时目录安全创建，不进入目标 working tree。小任务可用单份记录，待返修的证据保留并报告路径；一次性临时稿成功输出后可清理。中央固定使用 `notes.md`、`batches/` 与 Actions artifact，不受本地轻量布局影响。委派只在调用方允许、已有工具且至少两个 batch 可独立调查时使用，单层子任务仅返回指定范围证据；规则见 [工作稿与复核](skills/agentic-review/references/review-state.md)。

本地受信任运行时提供的持久记忆也可以作为 known issue 来源。主 Agent 应恢复可复核的原始记录；无法恢复原文的摘要只用于定位，不能单独证明“已修复”或“已确认”。

## 权限边界

每次任务用同一个 Review GitHub App mint 三个 installation token：

- **read token**：覆盖目标 owner 中安装了 Review App 的仓库，只有 `contents: read`、`issues: read`、`pull_requests: read`、`actions: read`、`checks: read`，给 checkout、Action 和 Agent 的只读 `gh` 使用；
- **check token**：只覆盖当前目标仓库且仅有 `checks: write`，在 Agent 启动前创建关联当前 Action Run 的 Check，不传给 Agent；
- **publication token**：只覆盖当前目标仓库，拥有 `contents: write`、`pull_requests: write`、`checks: write`，仅进入隔离的可信发布 job，用于创建 Review、完成 Check、thread 回复和 resolve/reopen。`contents: write` 是 GitHub GraphQL 执行 `resolveReviewThread`/`unresolveReviewThread` 的实际权限要求。

因此 Agent 即使被 PR 内容诱导执行 `gh pr comment`、`gh pr merge` 或写 API，也只有只读 token，GitHub 会拒绝写操作。

## 编写下游 `.agentic-review.md`

下游仓库可以在仓库根目录创建 `.agentic-review.md`，用自然语言补充**只有本项目知道、且会改变审查判断**的规则。它不是配置 schema，也不需要复制中央 Review 规则。

适合写入：

- 项目特有的 Review 重点及触发条件，例如修改鉴权时重点追踪租户归属，修改事件时重点核对消费者兼容性；
- 业务不变量和高风险边界，例如状态转换、租户归属、金额、业务日期、幂等和兼容性要求；
- 代码难以直接推断的调用关系、消费者、生成文件和不可执行区域；
- 真实的数据规模、批大小、并发、分页或延迟上限，供性能审查恢复契约；
- 本项目把哪些 GitHub Issue、历史 PR、测试记录或项目管理记录视为 known issue，它们如何影响判断，以及项目状态字段的实际含义；
- 需要联动查询的 GitHub 仓库完整地址、触发查询的代码路径或业务对象，以及稳定的具体 Issue/PR 链接或编号；
- 不适合重复写入本文件的已有项目上下文，可以在给出触发条件和用途后，引用具体文件路径，例如 `.agents/skills/order-domain/SKILL.md`。

写作时直接描述事实和操作条件：说明“何时检查什么、依据在哪里、怎样算完成”。Review 重点应绑定具体路径、文件类型、业务对象或变更信号，用来安排调查优先级，不能把其他 diff 排除在审查外。使用稳定的路径、字段、Issue 标签、记录 ID 或仓库地址；不写角色设定、宽泛的“仔细审查”、个人风格偏好，也不要把当前 known issue 全量复制进文件。

需要额外项目上下文时，说明触发条件、具体文件路径和用途。中央 Review 不自动枚举 Target Skill，只按这些显式引用读取。

下面是一个自然语言示例；标题和组织方式可以按项目调整：

```markdown
# 本仓库 Review 规则

## Review 重点

- 修改 `src/auth/`、Guard 或资源查询条件时，优先追踪“登录身份 → tenant_id → 数据库过滤”整条路径。
- 修改退款事件 schema 时，同时检查生产者、消费者和历史消息兼容性；完成条件是每个现有消费者都已核对。

## 业务约束

- 订单从 `paid` 进入 `refunded` 前必须已经写入支付平台退款单号；检查所有修改该状态的入口和补偿任务。
- `tenant_id` 来自登录身份，重试和冲突恢复不能改用请求载荷中的租户字段。

## 性能边界

- 批量导入单次最多 10,000 条；修改逐项数据库或远程调用时，按该规模检查往返次数和内存峰值。

## Known issues

- Issue `Qiyin-Tech/payment-service#389` 记录退款事件的兼容性决定；修改该事件时可读取该记录。
- 项目字段“已排期”只表示计划中；只有记录中的明确验收结论才能证明问题已修复。
- 修改订单、支付或退款状态时，按需查询 PRD `https://example.feishu.cn/wiki/wikcnRefundPRD`、验收记录 `https://example.feishu.cn/docx/doxcnRefundQA` 和 Issue 表 `https://example.feishu.cn/base/bascnIssues?table=tblIssues`；Issue 表的“已排期”只表示计划中，“已验收”才表示修复完成。其他变更不查询这些来源。

## 仓库约定

- `src/generated/` 由 schema 生成；审查 schema 和生成结果的一致性，不要求直接修改生成文件。

## 按需项目上下文

- 修改 `src/orders/` 中的状态转换、补偿或事件兼容性时，读取 `.agents/skills/order-domain/SKILL.md`，只用其中的订单状态和事件契约补充调查。
```

Review 读取输入提供的 base/head `.agentic-review.md` 与 `AGENTS.md`，按 head 理解合并后预期生效的规则，并审查规则本身的变化。中央可信规则预载后直接使用，compaction 后从控制面恢复；PR、评论和项目规则构成启动输入，diff 不拼接进去，而是按固定 SHA 从本地 Git 读取。Target Skill 不会被自动枚举；`.agentic-review.md` 可按当前变化显式引用具体文件，仅补充事实和调查路径，不能扩大权限或改写中央规则。

可信 workflow 在 Agent 启动前把只读 token 的可读集合固定为目标 owner 中安装了 Review App 的仓库，目标 PR 不能扩大这个集合。在该集合内，自动关联索引或审查输入中的明确稳定 Issue/PR 引用可以选择尚未在 merge base 声明的私有记录供 Agent 按需读取；这是既定产品边界，不需要 merge-base 预授权。关联只建立查询入口，不证明候选相关性或业务授权。单个 installation token 不能跨 owner，Agent 也不按关键词、`git blame` 或提交历史扩展 GitHub known issue 查询。

## 飞书登录和文件读取

使用维护者本人 OAuth 授权的用户身份读取飞书资料。你在浏览器确认一次授权后，可信任务每小时用 refresh token 换取新 token 并保存到 GitHub Environment Secrets；每轮 Actions 向 Lark CLI 注入短期 UAT，无需保存 runner、复制 CLI 登录目录或重复扫码。授权撤销、refresh token 失效或轮换中断导致新 refresh token 丢失时，需要重新授权。

实际读取权限是“应用已开通且用户已同意的 API scope”和“授权的企业用户身份对文档的访问权限”的交集。应用只申请所需读取权限，因此即使你能编辑文档，Review 也只获得这组只读能力。切换企业后的另一个身份不自动属于同一 UAT；跨企业文档需要共享给当前授权身份，并通过实际 API 读取验收。

从 `.env` 开始登录、验证文档及更换 App/用户，按[飞书操作手册](docs/lark-operations.md)执行；生产配置和续期机制见[飞书接入步骤](docs/deploy-central-review.md#4-飞书用户-oauth-与自动续期)。Agent 按 `central/lark-context.md` 读取明确提及的链接及相关引用文档，不主动搜索。

## 中央仓库配置

Repository variables：

- `AGENTIC_REVIEW_CLIENT_ID`：Review App Client ID；
- `REVIEW_AGENT_MODEL`：模型名称，必填；当前 workflow 使用 OpenAI-compatible provider；
- `REVIEW_AGENT_BASE_URL`：OpenAI-compatible gateway 地址，必填；
- `AGENTIC_REVIEW_LARK_APP_ID`：飞书企业自建应用 App ID；
- `AGENTIC_REVIEW_LARK_ROTATOR_CLIENT_ID`：只安装到中央仓库的 Lark Secret Rotator GitHub App Client ID。

Repository secrets：

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`：Review App private key；
- `REVIEW_AGENT_API_KEY`：模型 API key。

飞书长期凭证放在 `lark-rotation` Environment，Review 的 UAT 放在 `lark-review` Environment；具体名称与配置命令见部署说明。

App 安装范围与权限以 [部署说明](docs/deploy-central-review.md) 为准；App 权限与各任务签发的 token 权限需要区分。

## 本地检查

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

Worker 部署说明见 [`docs/deploy-central-review.md`](docs/deploy-central-review.md)。
