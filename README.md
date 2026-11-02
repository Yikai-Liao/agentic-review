# agentic-review

agentic-review 提供可独立安装的 Review Skill，也提供基于 GitHub App 的中央 PR Review 服务。

Skill 支持审查需求、架构、开发计划和代码，按需组合意图对齐、可维护性、可靠性、安全和验证等视角，各层级共用证据、结论与复核方法。Skill 名称为 `agentic-review`。

- **本地使用**：安装 Skill，审查已有文档或代码变化。
- **中央服务**：默认执行静态代码审查，也可由本轮请求或下游仓库指令选择其他层级；下游无需保存模型或 GitHub 凭证。

范围、迁移决定及验证记录见[通用化说明](docs/generalized-review.md)。程序接线检查与模型行为分别记录，已运行、未通过和未运行的验证按实际版本列明。

## 本地安装与使用

安装 main 发布版本时，在目标项目根目录执行：

```bash
npx skills add Qiyin-Tech/agentic-review --skill agentic-review --yes
```

使用尚未合入 main 的开发分支时，在隔离项目中复制当前 checkout 的整个 `skills/agentic-review/` 到 `.agents/skills/agentic-review/`，再显式调用 `$agentic-review`。上面的安装命令始终选择 main；同一宿主只加载一份同名 Skill。

本地可以审查未提交变化、指定 commit、分支差异，也可以明确选择需求、架构或计划。只审查已有产物，不直接创作或修复。例如：

```text
$agentic-review 审查当前未提交代码，覆盖行为、性能及测试契约；只读，不修复。
$agentic-review 审查 docs/requirements.md 的目标、范围与验收，以 docs/request.md 为原始依据。
$agentic-review 审查 docs/architecture.md 的状态、失败与恢复责任，不审查实现风格。
$agentic-review 审查 docs/plan.md 的依赖、迁移中间态和集成验收责任。
```

方法哲学、层级与视角的选择，以及 simplify/harden 的适用方法见 [Skill 入口](skills/agentic-review/SKILL.md)。

本地工作稿优先使用调用方提供的路径（如 `REVIEW_WORKSPACE_PATH`）；未提供时，在 Git 管理目录或系统临时目录安全创建，不进入目标 working tree。小任务可用单份记录。待返修的证据会保留并报告路径，一次性临时稿成功输出后可清理。

只有调用方允许委派、环境已有工具且至少两个 batch 可独立调查时，才使用单层委派；子任务仅返回指定范围的证据。具体规则见[工作稿与复核](skills/agentic-review/references/review-state.md)。

本地受信任运行时提供的持久记忆也可以作为 known issue 来源。主 Agent 应恢复可复核的原始记录；无法恢复原文的摘要只用于定位，不能单独证明“已修复”或“已确认”。

## 中央 PR Review 链路

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

中央 workflow 通过 [`shaftoe/pi-coding-agent-action`](https://github.com/shaftoe/pi-coding-agent-action) 运行 Pi。[中央入口](central/review-rules.md) 默认选择 code 层，承担五项审查职责：

- 行为与意图对齐；
- 安全边界；
- 可靠性与恢复；
- 性能与资源成本；
- 测试有效性。

测试审查默认只检查 T1 失真，T2 过约束须由本轮请求明确委托；测试经济性不参与中央审查。下游也可选择需求、架构或计划层，具体审查方法和证明要求见 [`skills/agentic-review/`](skills/agentic-review/)。

[`central/`](central/) 集中管理中央入口、GitHub 上下文、工作稿及可信发布格式。运行时先预载入口、共享规则和中央适配器，读取项目规则后再加载所选层级和视角；上下文压缩后，从控制面恢复规则。中央工作稿固定使用 `notes.md`、`batches/` 与 Actions artifact。

下游仓库用 `.agentic-review.md` 或 `AGENTS.md` 选择层级、补充项目约定。Review 读取输入提供的 base/head 两版规则，按 head 理解合并后预期生效的规则，并审查规则本身的变化。PR、评论和项目规则构成启动输入，diff 则按固定 SHA 从本地 Git 读取。

关联索引供契约恢复或候选复核时按需读取原始记录，不加载全量历史。

## 权限边界

每轮中央 Review 都使用同一个 Review GitHub App 签发三个短期 installation token：

- **read token**：覆盖目标 owner 中安装了 Review App 的仓库，只有 `contents: read`、`issues: read`、`pull_requests: read`、`actions: read`、`checks: read`，给 checkout、Action 和 Agent 的只读 `gh` 使用；
- **check token**：只覆盖当前目标仓库且仅有 `checks: write`，在 Agent 启动前创建关联当前 Action Run 的 Check，不传给 Agent；
- **publication token**：只覆盖当前目标仓库，拥有 `contents: write`、`pull_requests: write`、`checks: write`，仅进入隔离的可信发布 job，用于创建 Review、完成 Check、thread 回复和 resolve/reopen。`contents: write` 是 GitHub GraphQL 执行 `resolveReviewThread`/`unresolveReviewThread` 的实际权限要求。

Agent 的 GitHub 凭证只有 read token。即使被 PR 内容诱导执行 `gh pr comment`、`gh pr merge` 或调用写 API，GitHub 也会拒绝写操作。

可信 workflow 在 Agent 启动前，将可读仓库固定为目标 owner 中安装了 Review App 的仓库。目标 PR 不能扩大这个集合，单个 installation token 也不能跨 owner。

在可读集合内，自动关联索引或审查输入中的明确稳定 Issue/PR 引用，可以作为按需读取私有记录的入口，无须提前在 merge base 声明。关联只提供查询入口，不证明候选问题的相关性或业务授权。Agent 不按关键词、`git blame` 或提交历史扩展 GitHub known issue 查询。

## 编写下游 `.agentic-review.md`

下游仓库可以在仓库根目录创建 `.agentic-review.md`，用自然语言补充**只有本项目知道、且会改变审查判断**的规则。它不是配置 schema，也不需要复制中央 Review 规则。

适合写入：

- 审查层级及适用产物，例如需求文档按 requirements、设计文档按 architecture、开发计划按 plan；未指定时默认 code；
- 项目特有的 Review 重点及触发条件，例如修改鉴权时重点追踪租户归属，修改事件时重点核对消费者兼容性；
- 业务不变量和高风险边界，例如状态转换、租户归属、金额、业务日期、幂等和兼容性要求；
- 代码难以直接推断的调用关系、消费者、生成文件和不可执行区域；
- 真实的数据规模、批大小、并发、分页或延迟上限，供性能审查恢复契约；
- 本项目把哪些 GitHub Issue、历史 PR、测试记录或项目管理记录视为 known issue，它们如何影响判断，以及项目状态字段的实际含义；
- 需要联动查询的 GitHub 仓库完整地址、触发查询的代码路径或业务对象，以及稳定的具体 Issue/PR 链接或编号；
- 不适合重复写入本文件的已有项目上下文，可以在给出触发条件和用途后，引用具体文件路径，例如 `.agents/skills/order-domain/SKILL.md`。

直接描述事实和操作条件，说明“何时检查什么、依据在哪里、怎样算完成”。使用稳定的路径、字段、Issue 标签、记录 ID 或仓库地址，让 Agent 能找到依据。

Review 重点应绑定具体路径、文件类型、业务对象或变更信号，用来安排调查优先级，不能把其他 diff 排除在审查外。不写角色设定、宽泛的“仔细审查”或个人风格偏好，也不要把当前 known issue 全量复制进文件。

层级选择优先采用本轮请求中的明确要求，其次是 Head `.agentic-review.md`，再其次是 Head `AGENTS.md`；没有明确选择时使用 code。项目规则可以按路径或文件类型指定层级，层级改变不会缩小 PR 文件范围，也不会改变执行或发布权限。

需要额外项目上下文时，给出触发条件、具体文件路径和用途。中央 Review 不自动枚举目标仓库的 Skill（Target Skill），只按 `.agentic-review.md` 为当前变化显式给出的路径读取，用于选择层级、补充项目约定和调查路径。执行权限、共同证据门槛和可信发布协议继续由控制面定义。

下面是一个自然语言示例；标题和组织方式可以按项目调整：

```markdown
# 本仓库 Review 规则

## 审查层级

- `docs/requirements/` 下的需求文档按 requirements 层审查；`docs/architecture/` 下的设计文档按 architecture 层审查；其他变化默认 code。

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

## 飞书登录和文件读取

当前中央 Review 暂停飞书取证与判断：不准备 Lark CLI、不注入短期 UAT，飞书文档、Wiki 和多维表格链接只作来源标识，不会进入本轮判断。未读取飞书本身不形成额外告警或人工确认 finding。

飞书能力保留供以后恢复。维护者本人通过 OAuth 授权后，可信续期任务仍每小时用 refresh token 换取新 token，并保存到 GitHub Environment Secrets。授权撤销、refresh token 失效，或轮换中断导致新 token 丢失时，需要重新授权。

恢复读取时，再按 [`central/lark-context.md`](central/lark-context.md) 准备工具、注入短期用户访问令牌（UAT），并验证实际资料权限。

本地资料验证和恢复后的读取权限均受应用已开通且用户已同意的 API scope，以及授权企业身份的文档权限约束。切换企业后的身份不自动属于同一 UAT，跨企业资料需共享给授权身份并实际验收。

从 `.env` 开始授权、验证资料及更换 App/用户，按[飞书操作手册](docs/lark-operations.md)执行；生产配置和保留的续期机制见[飞书接入步骤](docs/deploy-central-review.md#4-飞书用户-oauth-与自动续期)。

## 中央仓库配置

完整部署步骤、App 安装范围与权限见[部署说明](docs/deploy-central-review.md)。下列变量和密钥配置在中央仓库。App 的安装权限与每轮 token 的权限范围需分别配置；各 token 的范围见上文“权限边界”。

Repository variables：

- `AGENTIC_REVIEW_CLIENT_ID`：Review App Client ID；
- `REVIEW_AGENT_MODEL`：模型名称，必填；当前 workflow 使用 OpenAI-compatible provider；
- `REVIEW_THINKING_LEVEL`：推理强度，必填；例如 `xhigh`，模型调用与发布页脚共用此值，未配置时 Review 明确失败；
- `REVIEW_AGENT_BASE_URL`：OpenAI-compatible gateway 地址，必填；
- `AGENTIC_REVIEW_LARK_APP_ID`：飞书企业自建应用 App ID；
- `AGENTIC_REVIEW_LARK_ROTATOR_CLIENT_ID`：只安装到中央仓库的 Lark Secret Rotator GitHub App Client ID。

Repository secrets：

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`：Review App private key；
- `REVIEW_AGENT_API_KEY`：模型 API key。

飞书长期凭证放在 `lark-rotation` Environment，保留供以后恢复读取的 UAT 放在 `lark-review` Environment；具体名称与配置命令见部署说明。

## 维护与检查

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

Review 方法和表达按 [Darwin 迭代流程](evals/README.md)演进：固定用例、新旧版独立生成、三评委匿名成对比较、长度与事实回归后才保留。评测工具、用例和精简结果纳入 Git；运行产物在 `evals/experiments/` 本地留存并忽略，不进入生产 Review，也不代替缺陷准确率评测。
