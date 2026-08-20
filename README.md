# agentic-review

中央 PR Review 控制面。下游仓库只安装 GitHub App，不保存模型或 GitHub 凭证，也不需要 Review workflow。

## 运行链路

```text
GitHub pull_request webhook
  -> Cloudflare Worker（验签、过滤、去重）
  -> 中央仓库 workflow_dispatch
  -> 三个短期 installation token
       ├─ read：给 Pi、Action 和只读 gh
       ├─ check：在 Pi 启动前创建关联 Check，不传给 Agent
       └─ publication：只给隔离的可信发布 job
  -> Pi 按中央 skills 审查，并在隔离工作区维护工作稿
  -> submit_review 封存最终 review-result.json
  -> 可信发布器创建一个完整 Review、更新历史 thread，并链接工作稿 artifact
```

中央 workflow 使用 [`shaftoe/pi-coding-agent-action`](https://github.com/shaftoe/pi-coding-agent-action)，不再维护自研 Pi SDK、multi-agent、aggregator 或 benchmark。`prompts/review-rules.md` 只负责阶段编排，运行时 skills 位于 `.github/pi-skills/`；下游仓库的自定义规则放在 `.agentic-review.md`，可以用自然语言补充项目特有的 known issue 来源、状态语义、关联 GitHub 仓库和飞书文档范围。Agent 先独立审查当前 diff，再按候选 finding 定向查询，不加载全量历史。

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
- 本项目把哪些 GitHub Issue、历史 PR、测试记录或项目管理记录视为 known issue，以及项目状态字段的实际含义；
- 需要联动查询的 GitHub 仓库完整地址，以及什么代码路径或业务对象出现时才需要查询；
- 需要查询的飞书文档/Wiki/多维表格完整 URL，或限定搜索范围的 folder token / space ID，以及触发查询的代码路径或业务对象；多维表格同时写明 Issue 表、关键字段和状态语义。

写作时直接描述事实和操作条件：说明“何时检查什么、依据在哪里、怎样算完成”。Review 重点应绑定具体路径、文件类型、业务对象或变更信号，用来安排调查优先级，不能把其他 diff 排除在审查外。使用稳定的路径、字段、Issue 标签、记录 ID 或仓库地址；不写角色设定、宽泛的“仔细审查”、个人风格偏好，也不要把当前 known issue 全量复制进文件。中央安全、证据、严重度和发布规则仍然生效，下游规则只能补充，不能覆盖。

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

- 本仓库带 `known-issue` 或 `qa-acceptance` 标签的 GitHub Issue，以及 Issue 中链接的验收记录，属于 known issue 来源。
- 修改退款状态、退款事件或对应 API 时，按需查询 `Qiyin-Tech/payment-service` 的相关 Issue、PR 和代码；其他变更不查询该仓库。
- 项目字段“已排期”只表示计划中；只有记录中的明确验收结论才能证明问题已修复。
- 修改订单、支付或退款状态时，按需查询 PRD `https://example.feishu.cn/wiki/wikcnRefundPRD`、验收记录 `https://example.feishu.cn/docx/doxcnRefundQA` 和 Issue 表 `https://example.feishu.cn/base/bascnIssues?table=tblIssues`；Issue 表的“已排期”只表示计划中，“已验收”才表示修复完成。其他变更不查询这些来源。

## 仓库约定

- `src/generated/` 由 schema 生成；审查 schema 和生成结果的一致性，不要求直接修改生成文件。
```

Review 同时读取 merge base 和 PR head 的 `.agentic-review.md`，按 head 理解合并后预期生效的规则，并审查规则本身的变化。为防止 PR 自行扩大 Agent 的私有数据访问范围，head 新增的私有关联仓库、飞书文档、folder token 或 space ID 在本轮只会被识别，不会读取；该声明合并后才授权后续 PR 查询。

相关私有仓库必须与目标仓库属于同一 GitHub owner，并安装 Review App。单个 installation token 不能跨 owner。具体飞书文档按 merge base 已声明的 URL 直接做关键词/章节读取；只有规则明确授权现有 folder 或 Wiki space 时才在该范围搜索。Agent 先独立分析当前 diff，再按候选 finding 定向追溯来源 PR 或搜索少量高相关记录，不会预读全部历史。

## 接入飞书文档

中央管理员只需配置一个组织自建应用：在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用，申请 `search:docs:read`、`docx:document:readonly`、`wiki:node:retrieve`、`drive:drive.metadata:readonly`、`base:app:read`、`base:table:read`、`base:field:read` 与 `base:record:read` 八个只读 scope，发布版本并通过管理员审核，然后把“凭证与基础信息”中的 App ID 配为中央仓库变量 `AGENTIC_REVIEW_LARK_APP_ID`，App Secret 配为中央仓库 secret `AGENTIC_REVIEW_LARK_APP_SECRET`。Lark CLI 固定使用 bot 应用身份，不保存用户登录态或长期 user access token。

各项目无需迁移或重组资料。对任意现有 Docx、Wiki 或多维表格，在分享/权限设置中“添加文档应用”并授予阅读权限；需要授权整个现有 folder 或 Wiki space 时才在对应成员设置中加入应用。高级权限多维表格还要把应用加入可读取目标记录的角色。应用的 API scope 与资源权限必须同时具备。完成授权后，在已合并的 `.agentic-review.md` 逐条写明完整 URL 及触发条件即可；Agent 会直接做文档内检索或 Base 服务端筛选。下游仓库不保存飞书密钥，也不安装 CLI。

如果主企业与三个子企业使用关联组织，子企业之间是否互联不影响主企业逐一授权；但官方对企业自建应用的默认保证仍是“同一企业内使用”，关联组织也不会自动赋予文档 API 权限。上线前必须分别在主企业和每个子企业用一篇真实文档与一张真实多维表格验证：子企业能否在“添加文档应用”中选到主企业应用，且同一 App ID/Secret 能成功读取。只有四个企业都通过才采用单应用；任一失败都说明当前租户配置不支持该路径，不能靠扩大 scope 修复，需要为该租户单独创建自建应用或开通关联组织应用共享。

Lark CLI `docs +fetch` 能读取文档正文、链接及支持的内嵌资源元数据。Figma 等第三方 iframe 的画布内容仍受第三方权限控制，Agent 只能把飞书返回的链接/占位信息标为证据缺口，不会绕过飞书去访问外部站点。

## 中央仓库配置

Repository variables：

- `AGENTIC_REVIEW_CLIENT_ID`：Review App Client ID；
- `REVIEW_AGENT_MODEL`：模型名称，必填；当前 workflow 使用 OpenAI-compatible provider；
- `REVIEW_AGENT_BASE_URL`：OpenAI-compatible gateway 地址，必填；
- `AGENTIC_REVIEW_LARK_APP_ID`：飞书企业自建应用 App ID。

Repository secrets：

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`：Review App private key；
- `REVIEW_AGENT_API_KEY`：模型 API key；
- `AGENTIC_REVIEW_LARK_APP_SECRET`：飞书企业自建应用 App Secret。

Review App 必须安装到目标仓库以及需要作为关联上下文读取的同 owner 仓库，并拥有 `Contents: read`、`Issues: read`、`Pull requests: write`、`Checks: write`、`Actions: read`。单个 installation token 不能跨 owner；其他 owner 的私有仓库不在当前读取范围。Dispatcher App 只安装到中央仓库，拥有 `Actions: write`，由 Worker 使用。

## 本地检查

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

Worker 部署说明见 [`docs/deploy-central-review.md`](docs/deploy-central-review.md)。
