# 部署中央 PR Review

## 1. Dispatcher App

在中央仓库所属 organization 创建 Dispatcher GitHub App：

- 关闭 webhook；
- 仅 `Actions: read and write`；
- 只安装到中央仓库。

Worker 使用它触发中央仓库的 `agentic-review.yml`，不使用它访问目标仓库。

## 2. Worker

Worker secrets：

- `WEBHOOK_SECRET`：Review App webhook HMAC secret；
- `DISPATCH_CLIENT_ID`：Dispatcher App Client ID；
- `DISPATCH_PRIVATE_KEY_PKCS8`：Dispatcher App 的 PKCS#8 private key。

Deployment vars：

- `CONTROL_REPOSITORY=owner/agentic-review`；
- `CONTROL_WORKFLOW_REF=main` 或固定 tag；
- `ALLOWED_OWNER=目标 owner`；
- `REVIEW_BOT_MENTION=@<actual-app-slug>`，必填，填写 Review App 的实际 slug 对应的 GitHub 提及形式。

```bash
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put WEBHOOK_SECRET
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_CLIENT_ID
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_PRIVATE_KEY_PKCS8
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml deploy
```

## 3. Review App 与中央仓库

创建 Review GitHub App，开启下列 repository webhook 事件，并安装到所有目标仓库、需要查询的同 owner 关联仓库以及中央仓库：

- `pull_request`：保留 `opened`、`reopened`、`synchronize`、`ready_for_review`；
- `issue_comment`：接收 PR 普通评论的 `created`；
- `pull_request_review_comment`：接收 inline thread 评论的 `created`。

编辑评论不触发新任务；Worker 还会过滤机器人自身、引用块、代码块和 inline code 中的 mention。`REVIEW_BOT_MENTION` 必须显式填写 Review App 的实际 slug 对应的提及形式。中央 publisher 从 `actions/create-github-app-token` 的 `app-slug` 生成 `REVIEW_BOT_LOGIN=<slug>[bot]`，不要手工配置另一个 bot 登录名。评论正文会原样进入 dispatch input；所有 `workflow_dispatch` inputs 受 GitHub 的 65,535 characters 总大小限制，超限请求明确失败且不截断。不要自行按单字段或 HTTP JSON UTF-8 字节计算，详见 [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs)。

手动补跑同样接受已合并的历史 PR；关闭但未合并的 PR 仍拒绝。即使源分支或 fork 已删除，也使用 GitHub PR 保存的 base/head SHA 下载代码并审查，无须恢复分支。`automatic` 请求仍须提交与 PR 保存快照一致的 SHA；结果和 Check 留在原 PR 与原 head 上。

App repository permissions 至少为：

- `Contents: read and write`（GitHub GraphQL 的 review thread resolve/unresolve 所需；write 只在 Agent 结束后签发给可信发布步骤）；
- `Issues: read`；
- `Pull requests: write`；
- `Actions: read`；
- `Checks: write`；
- `Metadata: read`（GitHub 默认权限）。

中央仓库 Actions variables：

- `AGENTIC_REVIEW_CLIENT_ID`：Review App Client ID；
- `REVIEW_AGENT_MODEL`：Responses API 接受的模型 ID，例如 `gpt-6-luna`、`deepseek-flash` 或网关自定义别名；workflow 会显式注册该 ID，无须出现在 Pi 模型目录中；
- `REVIEW_THINKING_LEVEL`：推理强度，必填；例如 `xhigh`，模型调用与发布页脚共用此值，未配置时 Review 明确失败；
- `REVIEW_FAST_MODE`：可选，`true` 主动请求 fast mode，`false` 或未配置时沿用 API 默认服务层；其他值在签发 Review token 前报错。请求参数和回退规则见下文；
- `REVIEW_AGENT_BASE_URL`：支持 `/responses` 的 API 基础地址；
- `AGENTIC_REVIEW_LARK_APP_ID`：飞书企业自建应用 App ID；
- `AGENTIC_REVIEW_LARK_ROTATOR_CLIENT_ID`：Lark Secret Rotator GitHub App Client ID。

中央仓库 Actions secrets：

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`：Review App private key；
- `REVIEW_AGENT_API_KEY`：模型 API key。

不要把上述 secrets 配到目标仓库。目标仓库不需要 `.github/workflows/review.yml`。

## 4. 飞书用户 OAuth 与自动续期

当前中央 Review 暂停飞书取证与判断：Review job 不安装 Lark CLI、不读取 `lark-review` Environment、不注入飞书凭据，也不等待 token 验证。授权、每小时 token 续期和以下接入说明保留，便于以后恢复；下游飞书链接当前只作来源标识，不触发查询或因未读取而新增告警。

首次接入、不清楚 `.env` 后如何关联个人文档，或需要更换 App/用户时，先按[飞书 App 与授权用户操作手册](lark-operations.md)执行。本文集中说明生产配置和续期机制。

### 登录状态保存在哪里

Actions runner 每轮都是新机器。持久化的是 OAuth token；恢复读取后，CLI 每轮通过环境变量使用 UAT；不缓存 CLI 登录目录，不在 Review 中执行 `auth login`。一个授权企业用户身份对应一条续期链路：

```text
你在浏览器授权飞书应用（所需只读 scope + offline_access）
  → 可信续期 job 得到 UAT 和 refresh token
  → lark-rotation Environment 保存 refresh token
  → lark-review Environment 保存 UAT
  → 当前保留并续期 UAT；中央 Review 暂不消费
  → 恢复读取后：Review job 注入 UAT，官方 lark-cli --as user 读取资料
```

定时任务独占 refresh token 并先保存下一代 refresh token，再发布 UAT。App Secret 和写 Environment Secret 的 GitHub token 只在续期 job 中使用，Review 的 `GH_TOKEN` 仍然只读。

### 创建飞书应用

1. 打开[飞书开放平台开发者后台](https://open.feishu.cn/app)，创建企业自建应用，例如 `Agentic Review`。当前方案不使用机器人能力，也不需要 OAuth 回调或 persistent runner。
2. 为**用户身份**申请 `offline_access` 和以下只读 scope：
   - `search:docs:read`：搜索用户可见的文档/Wiki；
   - `docx:document:readonly`：读取文档正文；
   - `wiki:node:retrieve`：解析 Wiki 节点和 space ID；
   - `drive:drive.metadata:readonly`：读取文档元数据；
   - `base:app:read`、`base:table:read`、`base:field:read`、`base:view:read`、`base:record:read`：读取多维表格结构、视图配置与 Issue 记录。
3. 发布应用版本并完成管理员审核。应用可用范围必须包含执行 OAuth 授权的维护者账号。
4. 使用专用 Review 应用，只开通这组只读 API 权限，不复用已被授予文档写权限的应用；`--as user` 和 `STRICT_MODE=user` 只固定身份，真正的读写限制由 OAuth scope 决定。`offline_access` 用于取得 refresh token，不是文档读取权限。将 App ID 写入中央仓库 variable `AGENTIC_REVIEW_LARK_APP_ID`。

### 配置 token 轮换权限

在中央仓库 Settings → Environments 创建 `lark-rotation` 和 `lark-review`，允许默认分支 `main`，不设置人工审批或等待计时器。私有仓库需要支持 Environment Secrets 的 GitHub 套餐。

另建一个 `Lark Secret Rotator` GitHub App：关闭 webhook，只授予 `Environments: read and write`，只安装到中央仓库。Environment Secret 写入实际要求该权限，不是 Repository Secret 的 `Secrets: write`。它只供 `.github/workflows/lark-token-refresh.yml` 使用，不复用或扩大 Review App 的权限。

配置下列初始值；`gh secret set` 不带 `--body` 会交互读取密钥，密钥不要放到命令行参数、聊天或日志中：

```bash
gh variable set AGENTIC_REVIEW_LARK_APP_ID --repo Qiyin-Tech/agentic-review --body '<飞书 App ID>'
gh variable set AGENTIC_REVIEW_LARK_ROTATOR_CLIENT_ID --repo Qiyin-Tech/agentic-review --body '<GitHub Rotator Client ID>'
gh secret set AGENTIC_REVIEW_LARK_APP_SECRET --repo Qiyin-Tech/agentic-review --env lark-rotation
gh secret set AGENTIC_REVIEW_LARK_ROTATOR_PRIVATE_KEY --repo Qiyin-Tech/agentic-review --env lark-rotation < /absolute/path/to/rotator-private-key.pem
```

两项自动轮换的 token 不手工初始化：

| Environment | Secret | 使用者 |
|---|---|---|
| `lark-rotation` | `AGENTIC_REVIEW_LARK_REFRESH_TOKEN` | 串行续期 job |
| `lark-review` | `AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN` | 保留供恢复读取后的 Review job 使用 |

[GitHub 在 workflow 排队时读取 Repository Secret，在 job 启动时读取 Environment Secret](https://docs.github.com/en/actions/reference/security/secrets#when-github-actions-reads-secrets)。因此动态 token 必须使用上述 Environment Secret，续期锁设在 job 层，避免排队任务拿到已消费的旧 refresh token，也避免排队的 Review 固定旧 UAT。不要另存同名 Repository Secret。

### 首次授权或新增用户权限

新增用户权限时，先在飞书应用后台开通并发布，再更新授权脚本中的 `larkScopes` 并合并到默认分支，最后按以下流程重新授权。普通 `refresh-lark-user` 续期不会扩展原有授权范围。

PR 合并后，使用有权操作中央仓库的维护者 GitHub 账号执行：

```bash
gh api --method POST repos/Qiyin-Tech/agentic-review/dispatches \
  -f event_type=authorize-lark-user
```

`repository_dispatch` 只加载默认分支上的可信 workflow，避免误选 PR branch 执行持有中央凭证的代码。立即打开 **Refresh Lark User Token** 运行日志中的飞书验证 URL，使用维护者本人账号确认授权。workflow 通过飞书 device flow 取得 UAT 与单次 refresh token，并直接创建：

- `AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN`；
- `AGENTIC_REVIEW_LARK_REFRESH_TOKEN`。

授权时选择需要用于读取的企业身份；成功后确认 workflow 为成功状态、两个 Environment 中都已创建 token secret。当前 Review 不消费飞书凭据，首次授权前也可正常审查；恢复读取时须重新验证身份与工具准备。

之后 workflow 每小时串行刷新一次。OAuth 请求只消费一次 refresh token；Secret 写入才对同一值最多重试五次，不重新兑换 token。定时调度不保证准点执行，token 的有效期以 OAuth 响应和运行日志为准；这是一条自动续期链路，不是永不过期的登录。

UAT 过期但 refresh token 仍有效、或新 refresh token 已保存而 UAT 写入失败时，发送一个**新**的刷新事件：

```bash
gh api --method POST repos/Qiyin-Tech/agentic-review/dispatches \
  -f event_type=refresh-lark-user
```

授权撤销、refresh token 失效、或新 refresh token 在保存成功前因写入失败/runner 终止而丢失时，重新发送 `authorize-lark-user` 并确认授权。Secret 重试不能保证跨飞书和 GitHub 的事务原子性；新 refresh token 丢失后无法由旧值恢复。不要复制旧 token 或把失败改成成功，也不要并行在本地消费这条续期链路。

### 恢复读取时验证主企业与三个子企业

可读范围是**应用已开通的用户 scope ∩ 用户已同意的 scope ∩ 当前企业用户身份的文档/表格权限**。用户 OAuth 不要求逐篇“添加文档应用”；文档所有者需要把资料共享给授权的那个用户身份。

同一手机号切换企业不代表同一个 OAuth 身份，不能保证一个 UAT 覆盖主企业和三个子企业。分别选择代表性 Docx、Wiki 和 Base，先在授权时选择的企业身份下确认共享，再实际通过 API 读取；跨租户共享策略和接口支持仍可能限制访问。需要切换身份才能看到的资料，须先解决共享或另行设计多身份接入，本 PR 不承诺跨企业自动通读。

恢复读取时，需要在 Agent 启动前准备并校验固定版本的官方 Lark CLI，再通过 `lark-cli api GET /open-apis/authen/v1/user_info --as user` 验证当前 UAT，并校验成功响应。它只证明登录有效，不证明文档权限；外部 token 模式下 CLI 禁用 `auth` 管理命令，不能用 `auth check` 或 `auth status` 验收。

用需要读取测试链接的 PR 验收：工作稿应包含 `docs +fetch` 的相关正文、Wiki 解析后的读取结果，以及 Base 的表、字段和目标记录原值。登录检查成功或 Review 总体成功都不能替代这些实际读取证据。权限错误按层处理：缺 scope 时在应用后台开通、发布并重新用户授权；文档 ACL 不足时向授权身份共享；Base 记录缺失时检查该用户角色的行列权限。

高级权限 Base 同样遵守该用户所属角色的表、字段和记录范围。Lark CLI 不会越过用户 ACL；Figma 等第三方 iframe 仍只能取得飞书返回的链接或占位元数据。

### 下游规则

以下规则供恢复读取后使用，当前中央入口的暂停范围优先。飞书读取遵循 `central/lark-context.md`，无需预先合并来源白名单。下游可在 `.agentic-review.md` 补充长期适用的链接、业务触发条件和表格状态语义，例如：

```markdown
## 飞书 Known issues

- 修改订单、支付或退款状态时，按需查询退款 PRD
  `https://example.feishu.cn/wiki/wikcnRefundPRD`、验收记录
  `https://example.feishu.cn/docx/doxcnRefundQA` 和 Issue 表
  `https://example.feishu.cn/base/bascnIssues?table=tblIssues`；其他变更不读取。
- Issue 表的“已排期”只表示计划中；“已验收”或正文中的验收结论才表示已修复。
```

Agent 可按审查需要读取明确提及的链接，继续读取相关且有权限的引用文档，不主动搜索文档；Base 表内记录定位使用筛选和最小字段投影。

## 5. Review 发布权限验证

每次中央 workflow 会 mint 三个 installation token：

| Token | 仓库范围 | 用途 | 权限 |
|---|---|---|---|
| read token | 目标 owner 中安装了 Review App 的仓库 | checkout、shaftoe action、`GH_TOKEN`、Pi bash 的 `gh` | `contents: read`、`issues: read`、`pull_requests: read`、`actions: read`、`checks: read` |
| check token | 仅当前目标仓库 | Agent 启动前创建关联当前 Action Run 的 Check | `checks: write` |
| publication token | 仅当前目标仓库 | Agent 结束后的可信发布步骤 | `contents: write`、`pull_requests: write`、`checks: write` |

可信 workflow 在 Agent 启动前将 read token 的可读集合固定为目标 owner 中安装了 Review App 的仓库；目标 PR 不能增加仓库或权限。在这个固定集合内，workflow 自动关联索引，或 `.agentic-review.md` 等审查输入中的明确稳定 Issue/PR 引用，可以选择尚未在 merge base 声明的私有记录供 Agent 按需读取；这是既定产品边界，不需要 merge-base 预授权。关联只建立查询入口，不证明候选相关性或业务授权。Agent 按 PR head 理解预期合并后的项目状态语义，只在当前 finding 确有需要时查询。单个 installation token 不能跨 GitHub owner，其他 owner 的私有仓库需要单独的 installation/token 设计。

`check token` 在 Pi 启动前创建 Check；publisher 使用封存并核对过的请求身份，重新校验结果 schema、scope、覆盖与 root comment 在当前 PR 中的归属，成功发布 Review、回复历史 thread 和执行 resolve/reopen 后，completion 才能标记成功。GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 除 `pull_requests: write` 外实际还要求 `contents: write`；该高权限 token 在 Agent 结束后才签发，只交给发布与 Check completion 步骤，不进入 Agent shell 或 Action input。审查与发布共用同一 job 和 runner；`prepare-review-context.ts` 收回代码、历史和输入的完整准备，`publish-review-run.ts` 收回可信校验、组装和发布。发布器的固定控制面代码在 Agent 启动前打包为准备步骤输出，Agent 结束后从 Runner 保存的输出恢复到全新临时目录执行，省去第二次 checkout；本地脚本改写不参与发布。请求上下文仍按准备步骤输出的 SHA-256 摘要校验，摘要缺失或上下文变化均阻断发布。请求摘要已固定但后续输入准备失败时，仍可保存该范围；Agent 未成功完成则不发布 Review。成功组装后记录 `workspace_ready`，成功与失败工作区按结果归档一次，保存范围及已有发布报告。自动 resolve/reopen 根据审查结论，不限制 thread 创建者。自定义 `submit_review` 扩展本身不读取 token，只校验并持久化 Agent 提交的结果对象；失败不能推进完整 audit checkpoint。

Review job 在 Agent 启动前检查 `rg`（ripgrep）是否可用；缺失时通过 Ubuntu 系统包管理器安装，已有时直接复用，并执行 `rg --version` 验证。安装或验证失败会停止本轮，避免 Agent 在调查中因缺少搜索命令重试。

Review job 使用 Pi 原生重试：`retry.baseDelayMs: 15000`，连续重试等待 15、30、60 秒，其余沿用当前 Action 内置 Pi 1.3.0 默认设置。中央模型窗口为 `272000`，输入与输出共用，单次输出上限为 `25000`。启动材料预载按同一窗口计算预算。

上下文由 [`pi-fold`](https://github.com/shaneconner/fold) 管理，版本固定在 workflow 的 `PI_FOLD_VERSION`，在 Agent 启动前安装并按版本缓存。窗口达到 80% 时，它把最早完成的工具批次折叠成由代码生成的简短摘要，原文仍保存在会话 JSONL 中；整轮审查是同一个未结束的 user 回合，pi-fold 把该回合的首条 user 消息（启动 Prompt 与预载规则）视为不可折叠；集成测试用约 100KB 的 Prompt 连续提交多次折叠，最后一次请求仍包含完整 Prompt。预载审查材料是否可被折叠没有单独验证。折叠不调用模型，因此不会出现原生压缩那样耗时的摘要请求：PR #129 的自审曾在 256K 触发原生压缩，摘要请求运行 58 秒后失败，整轮作废。pi-fold 会把超过 16KB 的 `read` 结果截成前 16KB，完整内容写入会话目录下的 `pi-fold-evidence/`，模型可按路径继续读取；bash 输出只在 Pi 自身已截断时才另存。这一截断不可关闭；历史 134 个 session 中，超过 16KB 的 `read` 只有 18 次，Review 主要通过 bash 读取代码。

Pi settings 的 `compaction.enabled` 与 Action 的 `auto_compaction` 仍为 `true`：pi-fold 会先于阈值压缩折叠，原生压缩只在折叠后仍溢出时兜底。`review-runtime` 在原生压缩失败时先输出失败原因，再中止本轮。

中央 workflow 不提供模型自行调用的压缩、解压或上下文搜索工具；pi-fold 自带的 `pi_fold_context` 也不加入 `loaded_tools`。此前的 `billion-context-pi` 让模型自行调度压缩，前端 PR #483 的 3 文件变化曾产生 74 个回合、21 次手动压缩和反复规则恢复，形成明显耗时回退。可信规则仍直接预载；只有当前步骤所需的正文确已丢失时才补读，调查完成后直接刷新讨论并提交。

原生行为也有明确限制：Pi 1.3.0 按完整错误文本匹配 `billing`，因此包含 `/account/billing` 帮助链接的 TPM 错误也会被判为不可重试，当前项目不再自行改写或重新分类；隔离验收保留了这个实际失败。普通回合的原生指数等待不解析正文中的 `Please try again in …s`。provider 层的服务端等待上限默认 60 秒，超过上限的错误仍可能被原生会话或摘要预算再次尝试；不能将默认逻辑描述为一定等满正文提示。原始错误和失败结果均保留，耗尽或不可重试时不发布成功 Review。

Agent 的时间预算为 9 分钟（`REVIEW_TIME_BUDGET_SECONDS=540`），`Run Pi review` 步骤最多运行 15 分钟，review job 最多运行 30 分钟，为预算之外的模型调用收尾、审查前的准备和审查后的发布、结果上传留出时间。重试耗尽后仍会失败并由 publisher 保留工作稿。若固定 TPM 下仍频繁限流，应减少单次输入或并发请求；增加重试次数不能提高吞吐额度。Pi 的配置与扩展接口见 [Settings Reference](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/settings.md#network-and-retries) 和 [Extensions](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/extensions.md)。

修改请求恢复或摘要边界后，除普通测试外，使用与 Action 对应的 SDK 做隔离验收。下面的测试只连接本机模拟 HTTP/SSE 服务，覆盖真实自动压缩、流内恢复和会话落盘，不调用模型 API，也不增加生产依赖：

```bash
pi_sdk_check_dir="$(mktemp -d)"
npm install --prefix "$pi_sdk_check_dir" --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.3.0
PI_SDK_DIRECTORY="$pi_sdk_check_dir/node_modules/@earendil-works/pi-coding-agent" pnpm exec tsx --test test/pi-runtime.integration.ts
rm -rf "$pi_sdk_check_dir"
```

修改 pi-fold 版本、扩展加载顺序或窗口配置后，用 Action 发布产物验证真实加载、折叠和会话落盘。测试让模拟模型连续读取证据把窗口推过阈值，确认连续发生多次折叠、没有摘要请求、完整启动 Prompt 仍在窗口中：

```bash
pi_fold_check_dir="$(mktemp -d)"
git clone --depth=1 --branch v2.30.1 https://github.com/shaftoe/pi-coding-agent-action.git "$pi_fold_check_dir/action"
npm install --prefix "$pi_fold_check_dir/extensions" --ignore-scripts --no-audit --no-fund --no-package-lock --legacy-peer-deps pi-fold@4.3.0
PI_ACTION_DIRECTORY="$pi_fold_check_dir/action" PI_FOLD_DIRECTORY="$pi_fold_check_dir/extensions" pnpm exec tsx --test test/pi-fold.integration.ts
rm -rf "$pi_fold_check_dir"
```

Action 开启 `export_session_jsonl` 后使用原生落盘会话。每次运行将 `~/.pi/agent/sessions/` 下的原始 JSONL（含折叠与原生 compaction 记录）及 `pi-fold-evidence/` 归档为 `review-session-<repository-id>-<pull>-<source>-<run>-<attempt>`，保留 7 天。上传在 Agent 成功、失败或取消后执行，不依赖 Action 成功完成导出，因此导出前异常或超时也可保留已写盘部分；runner 丢失或尚未落盘的内容无法补回。日志包含系统消息、工具定义、输入、回复、工具结果和原生压缩记录，用于重建调查过程。归档不包含上层 `auth.json` 或运行时配置。首轮另记录 `[review-cache-prefix]` 的固定前缀、工具、系统消息与规则哈希，不输出正文，用于快速定位跨运行差异。当前规则与工具配置相同时，增补材料位于固定规则之后，不能改变固定断点之前的前缀。

`REVIEW_FAST_MODE=true` 时，`Configure Pi runtime` 在 Agent 启动前向配置的模型网关发送一次短 Responses 请求，探测 `service_tier: "priority"`（[OpenAI fast mode](https://developers.openai.com/api/docs/guides/fast-mode)）。响应确认 `priority`/`fast` 后，将该参数写入 Pi 的模型配置；网关或模型明确拒绝（HTTP 400/422），或响应未确认优先服务层时，本轮沿用 API 默认模式。正式 Review 直接使用 Pi 原生请求链路，不包装 fetch 或重复探测。探测的鉴权、配额、限流、网络及无关参数错误会使准备步骤失败；关闭开关时不探测，也不覆盖 API 项目自身的默认服务层设置。Fast mode 可能采用更高单价，额外的启动探测不计入 Review 主会话的 token 和费用统计。

发布统一采用 fail soft：公共输入校验失败停止全部写入；校验通过后，正文、每条 finding、请求回复、每个 thread 的状态同步和证据回复各自执行，异常只阻断依赖该操作的后续步骤。查询失败不能当作空列表继续写入。正文与 finding 分开请求，避免一条无效行号使全部结果无法发布；失效的历史 thread 也不影响其他结果。工作稿上传与发布按实际前置依赖编排，上传失败不阻断已经准备好的 GitHub 写入。

发布前上传 `review-workspace-<repository-id>-<pull>-<source>-<run>-<attempt>`，保留 `notes.md`、文件进度、结果及可信范围；Agent 或发布失败时，下一轮仍可恢复其中未完成的范围。发布成功后，`publication-report.json` 随 `review-completed-workspace-<repository-id>-<pull>-<source>-<run>-<attempt>` 一起归档，不再单独上传成功报告。发布失败时，报告单独存入 `review-publication-<run>-<attempt>`；草稿组装或归档失败时另存原始诊断稿，不将其当作可恢复范围。原有工作区命名和历史查找协议保持一致。

`publication-report.json` 在摘要与 coverage 写入后保存，记录发布操作及依赖、结果和错误，也包含这两个出口的结果。Actions 摘要记录此前的 GitHub 操作；Check 详情最后写入，列出此前全部操作，包括报告自身的存储结果和存储失败后的 coverage 回写结果；Check 详情写入失败同样回写 coverage，其结果只在进程日志中。进程日志最后汇总全部操作。任一操作失败或被前置失败阻断，publisher 在完成其余操作后以非零状态结束，coverage 保持 `draft`，完整 audit checkpoint 不推进。报告存储失败或完成工作区上传失败同样不能让 Check 成功。全部操作成功时，正文和回复不附加执行说明；正文或请求回复发布前已有操作失败或被阻断时，开头提示失败数量。正文中的历史状态是审查判断，实际执行结果以运行报告为准。

同一运行重跑时，publisher 完整分页读取本 bot 发布的标记，复用已发布的正文、finding 和回复；正文中的执行说明按本次结果更新，resolve/reopen 重新核对远端状态。标记绑定运行、目标 PR、head、操作及内容。写请求报错可能意味着远端已生效，本轮不盲目重试；下次先核对标记。GitHub 写入与网络响应并非原子事务，远端尚不可见时无法保证恰好一次发布。

### 每轮一条 Review 与旧总评收起

本轮新 finding 作为 `comments[]` 随总评一次 `POST /pulls/{n}/reviews` 发布，页面上只新增一条时间线记录。整条 Review 会因任一行号不在 diff 中被 GitHub 拒绝，因此 `submit_review` 在提交时按 `git diff -M --unified=3` 的右侧 hunk 核对每条 finding，越界时返回该文件的可评论范围让模型修正，发布阶段不再逐条重试。无法绑定 diff 行的 finding（`line: null`）挂在 PR 改动文件上：创建 Review 的 `comments[]` 不支持文件级评论，publisher 在总评之前用 `POST /pulls/{n}/comments` 加 `subject_type: file` 逐条发布，每条单独占一条时间线记录；任一条失败时不发布总评，留待重跑补齐。这样总评一旦存在，它列出的讨论都已存在，后续审查读取 PR 时不会漏掉其中的问题。它与 inline finding 一样有 thread 状态，计入标题和索引，下一轮可标注和关闭。`submit_review` 校验 `path` 属于 PR 改动的文件。

总评首行带发布标记与 `agentic-review:automatic-summary` 标记，第二行是 publisher 生成的标题。新的 automatic 总评发布后，publisher 用 `PUT /pulls/{n}/reviews/{id}` 把同一 PR 中本 bot 更早、尚未收起的 automatic 总评改为一行“已被某次审查取代”的指向（带 `agentic-review:superseded` 标记），原文放进 `<details>`，可展开查看，下一轮输入也仍能读取。按 Review ID 判断先后，同一运行重跑只收起比自身更早的总评，并补做上次失败的收起；已收起的总评不会被重跑恢复。本运行的总评已被后续审查接管时，重跑不再改动 thread 状态、标注或回复，以免覆盖后续审查的判断；为此 thread 状态写入需要先读到 Review 列表，读取失败时不写。本运行从未发出总评时（例如文件级讨论失败），同一 head 上的重跑是最后一次发布，讨论、总评和 thread 状态整体取代此前的结论。评论请求的答复可能只覆盖局部范围，既不收起其他总评，也不被收起。收起只改总评正文，其下的 inline 讨论不受影响。

没有新 finding、没有 thread 状态变化且标题与最新 automatic 总评相同时，publisher 就地更新该总评，不新建 Review。就地更新把新发布标记追加在首行已有标记之后：旧运行重跑仍能凭自己的标记找到这条总评，而首行不以自己的标记结尾，说明它已不是当前结论，重跑不改写正文，也不重复发布 finding。关闭历史问题时，publisher 在本 bot 创建的 root 首行写入带 `agentic-review:status` 标记的状态标注，再 resolve，不另发回复；重现、风险升级，或 root 不是本 bot 创建时才回复。每次收起、标注和回复都是独立的发布操作，失败时计入运行报告和 Check 结论，不影响已发布的新总评。

### 评论请求、范围与历史

评论进入中央 workflow 时只携带评论正文和身份，不携带固定 base/head；workflow 在实际开始时读取当前 PR 快照并固定本轮比较起点。评论任务不会拿不存在的旧 SHA 做快照校验；自动 `pull_request` 事件才会在排队后校验原始 base/head，过时就显式失败。runner 在普通失败路径上尽可能上传已有工作稿；硬中断不承诺保存。评论事件正文保存完整原文。

中央任务把原文交给 Agent 判断范围，优先级是“显式自然语言范围 > thread 隐含范围 > PR 默认规则”。普通 PR 评论重新调查最近一次 PR 级请求的实际范围：即使没有代码变化也重新给出当前证据；有变化则审查新增变化和直接影响，并补齐上次失败或未完成的覆盖。thread 默认调查当前问题及直接影响，只有原文明确要求全 PR 才扩大，且不继承 PR 级范围历史。默认 scope 与可复用 workspace 由可信准备代码初始化；Agent 仅在范围变化时调用 `set_review_scope`，并更新 `review-progress.json` 中的文件进度。可信代码负责请求身份、batch 汇总和最终 `review-coverage.json` 历史记录。最终结果自动使用本轮 scope，无须复制 ID。

同一 PR 的最近 PR 级请求工作稿按控制仓库 Actions artifact 的 repository ID、PR、source、run 和 attempt 查找，不依赖 ancestor/base 关系；失败、跳过发布和草稿都可作为范围历史，排除 thread 工作稿和当前运行。查找不到、artifact 过期或 GitHub 接口错误分别记录，不能把错误当成“无历史”而改变范围。历史工作稿只读。成功的完整 `audit` checkpoint 仍需独立的成功 Check、提交关系和 base/head 校验；局部成功不能推进它。

### 同 PR 并发队列

中央 workflow 在 workflow 级使用 `repository_id` 与 `pull_number` 组成 concurrency group，Review 与 publish 共享同一槽位；不同 PR 可以并行。配置为 `queue: max` 和 `cancel-in-progress: false`：同一 PR 最多一个运行中的任务，最多 100 个 pending 任务，队列满后 GitHub 会取消新增任务。FIFO 依据任务开始等待的时间，不保证 webhook 发出时间的绝对顺序。详见 [GitHub Actions concurrency 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

Review footer 分两行，标签均为中文：第一行先放“运行记录”和“审查工作稿”两个链接，再给出审查位置（本轮 head 与上次完整审查的 head）和已审文件数（含由来源 PR 审过的数量）；第二行是模型、推理档位、耗时、Token 数、Pi SDK 返回的美元费用估算和规则版本。GitHub 评论把单个换行渲染为换行，两行之间不留空行。thread 状态更新回复只链接运行，运行信息以同轮总评为准。费用保留四位小数，小于 $0.0001 时显示 `<$0.0001`，没有费用统计时明确显示“未提供”。显式注册的模型不在 Pi 目录中，SDK 会把它的费用算成 0。`review-cost` 扩展在首次请求前从 Pi 模型目录取价（含分档价格）：优先精确模型 ID；目录没有时，取同系列、同档位名中版本最高的型号，例如 `gpt-6.1-terra` 取 `gpt-5.6-terra`。后一种是估价，不是该模型的真实价格；同名模型在不同 provider 的价格可能不同，优先取 `openai`。目录中找不到可用价格的网关别名仍可正常审查，但用量统计标记价格未知（`priceKnown: false`），Review footer 与 Check 详情中的所有费用均显示“未提供”，不显示 $0.0000。费用不代表网关实际账单。Action 版本通过运行链接查看，审查的具体范围以工作稿为准。

中央 OpenAI Responses 请求使用稳定的 `prompt_cache_key: "agentic-review"`。仓库 Actions Variable `REVIEW_EXPLICIT_PROMPT_CACHE` 控制显式缓存：未设置或 `false` 时关闭，普通自动缓存由 Pi 和中转站处理；仅在确认当前网关和模型支持后设为 `true`。变量通过 workflow 环境映射到 Pi 的 `compat.supportsExplicitPromptCacheMode`，覆盖模型目录对官方服务的能力声明；非法布尔配置会使准备步骤失败。`supportsLongCacheRetention` 控制长期保留参数，不能替代此开关关闭显式断点。

开启后，在固定规则 user 消息末尾增加 `prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" }`，并使用 `prompt_cache_options: { mode: "implicit", ttl: "30m" }` 给动态材料缓存。关闭时不加入这两类请求参数。缓存扩展保留完整消息正文、角色和顺序，会话标头仍由 Pi 独立生成。开启时若首个请求无法定位固定规则则中止，长审查压缩已移除原规则消息后沿用当前上下文，不重新插入旧消息。实际命中仍取决于前缀、有效期和服务端缓存。固定规则直接从可信控制面预载，不再安装到 Pi 的自动发现目录，避免系统再次要求读取同一 Skill。

显式断点属于请求元数据，不增加 Prompt 正文 token 或模型调用。固定前缀的 12h 与动态材料的 30m 用于请求上游缓存策略，不决定中转站的收费规则。当前中转站统一计算缓存写入，不区分 TTL；费用估算直接采用 SDK 已配置的缓存写入价格，不因为请求了 12h 而再加价。12 小时从写入计时，不能将每次命中理解为重新获得 12 小时，缓存语义见 [OpenAI 缓存生命周期说明](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime)。冷启动、规则变化或长期缓存失效仍需写入，是否节省取决于后续复用次数和间隔。

每个模型回合的普通输入、缓存读取、缓存写入、输出、推理 Token 和各项费用估算记录在会话 JSONL 对应 assistant 消息的 `usage` 中，运行日志不再逐回合输出。`reasoning` 已包含在 `output` 中，不能重复相加；普通输入不含缓存两项。费用直接沿用 Pi SDK 返回的统计，不改写消息用量或费用，也不要求中转站返回 TTL 写入明细。扩展通过 `message_end` 校验标准 Token 和费用数值；统计本身缺失或损坏时仍中止并移除旧费用文件，发布不能使用先前回合的统计掩盖失败。Check 详情展示总缓存写入量及 SDK 估算，不展示网关未承诺的生命周期拆分。统计不保存 Prompt、源码、评论或模型正文，也不额外发起模型请求。失败回合保留 SDK 已报告的用量；完整会话费用继续以 Action 汇总为准。比较上线前后时分别统计初审和复审，并核对第一轮固定前缀的缓存写入是否转为读取；缓存 key 改动本身不保证实际节省金额。

相同回合统计累计保存为工作区的 `review-usage.json`，随现有 artifact 归档。可信发布器校验数值后，在 Check 详情的用量部分展示回合数、首轮缓存命中率、首轮普通输入/缓存读取/缓存写入，以及累计 token 和费用分项；命中率分母是首轮普通输入、缓存读取、缓存写入之和，零输入单独说明。缺失的推理分项显示未提供，不当作零。分项只统计审查回合，总费用仍采用 Action 汇总；规则版本同时显示为控制面 SHA，便于比较。统计缺失或损坏时发布失败，不填造零值；该文件不保存会话正文，也不参与覆盖完成或请求身份判断。

footer 以固定元数据标记包围。准备输入、读取关联 PR 和刷新讨论时，只剔除当前 Review App 自己生成的此区域，避免运行信息增加下轮输入费用；完整统计保存在 Check 详情和 artifact 中。审查结论、发布幂等标记、人工回复与其他机器人正文保持不变，统计之外的判断编辑仍正常进入增量讨论。

页脚链接当前 Actions 运行的 artifacts 区域，其中包含可恢复草稿、完成工作区或失败诊断报告；保留期以 workflow 的 `retention-days` 为准，访问者必须登录且拥有中央仓库权限。Check Run 的 `details_url` 指向中央仓库当前 `${GITHUB_RUN_ID}`。GitHub known issue 查询使用中央 Skill 和只读 `gh`。

### 复盘数据

PR 页面只面向读者：最新总评完整展示，旧 automatic 总评收起为一行指向，footer 只占一行。复盘按下表读取，不从 PR 正文解析统计。

| 数据 | 位置 | 保留 |
| --- | --- | --- |
| 运行信息、审查结果计数、覆盖、用量与费用分项、未成功的发布操作 | 每次运行的 Check（`Agentic Review / audit` 或 `/ requested`）的 `output.text` | 随目标仓库的提交保留 |
| 每轮总评原文（旧总评在折叠区内）；finding、状态标注、状态更新与人工回复 | PR Review、inline thread | 随 PR 保留 |
| 发布操作的错误原文 | Actions 摘要、`publication-report.json` | 运行日志保留期；artifact 7 天 |
| `notes.md`、会话 JSONL、`pi-fold-evidence/` | workspace 与 session artifact | 7 天 |

Check 详情由发布器生成，经发布步骤输出交给 Check completion，Agent 不能写入该输出；发布器未运行到写出时，Check 只有结论和摘要。详情只列操作 ID 与状态，不含错误原文。读取示例：

```sh
gh api graphql -f query='query($owner:String!,$name:String!,$pull:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pull){commits(last:100){nodes{commit{oid checkSuites(first:20){nodes{checkRuns(first:20,filterBy:{checkName:"Agentic Review / audit"}){nodes{databaseId conclusion text}}}}}}}}}}' \
  -f owner=<owner> -f name=<repo> -F pull=<number>
```

旧总评是否已收起，看正文第二行是否带 `agentic-review:superseded` 标记。会话 JSONL、`pi-fold-evidence/` 与 `notes.md` 含目标仓库源码或引用片段，保留期维持 7 天；需要深入分析调查过程时，在过期前导出到 Git 忽略的 `evals/experiments/` 并在报告中注明。

如果 Review 发布失败，先检查：

1. Review App 是否安装到目标仓库和需要读取的关联仓库；
2. App 是否包含 `Issues: read`、`Pull requests: write` 和 `Contents: read and write`，且安装已接受最新权限；
3. Actions secret 中的 private key 是否属于该 App；
4. Agent 的 `github_token` 与 `GH_TOKEN` 是否仍绑定只读 token，且 publication token 只在 Agent 结束后签发并传给可信发布步骤；
5. publisher 使用的 `repository`、`pull_number` 和 base/head SHA 是否来自 webhook dispatch input。
6. Worker 的 `REVIEW_BOT_MENTION` 是否对应 Review App 的实际 slug；中央 workflow 发布环境中的 `REVIEW_BOT_LOGIN` 是否为同一 slug 加 `[bot]`。

## 6. 验证

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm dlx wrangler@4.123.0 deploy --dry-run
```

用一个测试 PR 确认中央 workflow 日志中：Agent 的 `gh` 使用 read token，最后创建了一个 GitHub Pull Request Review，而不是普通 issue comment。
