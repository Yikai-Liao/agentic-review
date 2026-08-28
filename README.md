# agentic-review

可复用的静态 Review Skill 与中央 PR Review 控制面。开发者可以在任意 Git 仓库本地审查 working tree、commit 或分支差异；中央服务仍只要求下游安装 GitHub App，不向下游保存模型或 GitHub 凭证。

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

中央 workflow 使用 [`shaftoe/pi-coding-agent-action`](https://github.com/shaftoe/pi-coding-agent-action)，不再维护自研 Pi SDK、multi-agent、aggregator 或 benchmark。唯一 Review 方法论位于 `skills/agentic-review/`；workflow 只用 `central/` 下的普通文档接入 GitHub 上下文和可信发布。下游仓库的自定义规则放在 `.agentic-review.md`，可以用自然语言补充项目特有的 known issue 来源、状态语义和关联 GitHub 仓库。Agent 先独立审查当前变化，再按候选 finding 定向查询，不加载全量历史。

## 本地安装与使用

在目标项目根目录安装唯一的 Project-level Skill：

```bash
npx skills add Qiyin-Tech/agentic-review --skill agentic-review --yes
```

随后可以要求当前 Agent 审查未提交变化、指定 commit 或与某个分支的差异。本地工作稿默认放在当前 worktree 的 Git 管理目录 `agentic-review/review.*` 下，不污染 working tree 或 `git status`，成功输出后删除；调用方设置 `REVIEW_WORKSPACE_PATH` 时改用该路径。当前环境已经提供 Agent delegation 工具且存在多个独立 batch 时，主 Agent 可以委派一层 worker；否则按同一方法顺序完成，不依赖 Pi、Codex、Claude Code 或特定插件名称。

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
- 本项目把哪些 GitHub Issue、历史 PR、测试记录或项目管理记录视为 known issue，以及项目状态字段的实际含义；
- 需要联动查询的 GitHub 仓库完整地址，以及什么代码路径或业务对象出现时才需要查询。

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

## 仓库约定

- `src/generated/` 由 schema 生成；审查 schema 和生成结果的一致性，不要求直接修改生成文件。
```

Review 同时读取 merge base 和 PR head 的 `.agentic-review.md`，按 head 理解合并后预期生效的规则，并审查规则本身的变化。中央 workflow 还会列出 Target 的 `.agents/skills` 和 `.pi/skills`：其他项目 Skill 可以按需作为不可信项目上下文读取，所有 frontmatter `name: agentic-review` 的副本都会在进入 Agent 前从清单排除，方法论始终来自中央可信 checkout。为防止 PR 自行扩大 Agent 的私有数据访问范围，head 新增的私有关联仓库在本轮只会被识别，不会读取；该声明合并后才授权后续 PR 查询。

相关私有仓库必须与目标仓库属于同一 GitHub owner，并安装 Review App。单个 installation token 不能跨 owner。Agent 先独立分析当前 diff，再按候选 finding 定向追溯来源 PR 或搜索少量高相关记录，不会预读全部历史。

## 中央仓库配置

Repository variables：

- `AGENTIC_REVIEW_CLIENT_ID`：Review App Client ID；
- `REVIEW_AGENT_MODEL`：模型名称，必填；当前 workflow 使用 OpenAI-compatible provider；
- `REVIEW_AGENT_BASE_URL`：OpenAI-compatible gateway 地址，必填。

Repository secrets：

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`：Review App private key；
- `REVIEW_AGENT_API_KEY`：模型 API key。

Review App 必须安装到目标仓库以及需要作为关联上下文读取的同 owner 仓库，并拥有 `Contents: read`、`Issues: read`、`Pull requests: write`、`Checks: write`、`Actions: read`。单个 installation token 不能跨 owner；其他 owner 的私有仓库不在当前读取范围。Dispatcher App 只安装到中央仓库，拥有 `Actions: write`，由 Worker 使用。

## 本地检查

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

Worker 部署说明见 [`docs/deploy-central-review.md`](docs/deploy-central-review.md)。
