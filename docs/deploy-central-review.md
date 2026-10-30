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

App repository permissions 至少为：

- `Contents: read and write`（GitHub GraphQL 的 review thread resolve/unresolve 所需；write 只签发给隔离的可信 publish job）；
- `Issues: read`；
- `Pull requests: write`；
- `Actions: read`；
- `Checks: write`；
- `Metadata: read`（GitHub 默认权限）。

中央仓库 Actions variables：

- `AGENTIC_REVIEW_CLIENT_ID`：Review App Client ID；
- `REVIEW_AGENT_MODEL`：例如 `gpt-5.6-luna-2`；当前 workflow 使用 OpenAI-compatible provider；
- `REVIEW_AGENT_BASE_URL`：OpenAI-compatible gateway 地址；
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
| publication token | 仅当前目标仓库 | 隔离的可信 publish job | `contents: write`、`pull_requests: write`、`checks: write` |

可信 workflow 在 Agent 启动前将 read token 的可读集合固定为目标 owner 中安装了 Review App 的仓库；目标 PR 不能增加仓库或权限。在这个固定集合内，workflow 自动关联索引，或 `.agentic-review.md` 等审查输入中的明确稳定 Issue/PR 引用，可以选择尚未在 merge base 声明的私有记录供 Agent 按需读取；这是既定产品边界，不需要 merge-base 预授权。关联只建立查询入口，不证明候选相关性或业务授权。Agent 按 PR head 理解预期合并后的项目状态语义，只在当前 finding 确有需要时查询。单个 installation token 不能跨 GitHub owner，其他 owner 的私有仓库需要单独的 installation/token 设计。

`check token` 在 Pi 启动前创建 Check；publisher 使用封存并核对过的请求身份，重新校验结果 schema、scope、覆盖与 root comment 在当前 PR 中的归属，成功发布 Review、回复历史 thread 和执行 resolve/reopen 后，completion 才能标记成功。GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 除 `pull_requests: write` 外实际还要求 `contents: write`；该高权限 token 不进入 Agent shell，也不进入 review job。自动 resolve/reopen 根据审查结论，不限制 thread 创建者。自定义 `submit_review` 扩展本身不读取 token，只封存 Review 工作区内的最终 JSON；失败不能推进完整 audit checkpoint。

Review job 在 `Configure Pi runtime` 阶段显式写入 Pi 的 `~/.pi/agent/settings.json`：禁用 Agent 层重放，只保留 3 次 provider 层 HTTP 429/5xx 重试，形成单一 retry budget；provider 层优先遵循服务端的 `Retry-After`，单次服务端退避上限为 120 秒（最多 3 次等待，即 360 秒），从而不会在 provider retry exhaustion 后再次复制整轮请求。`Run Pi review` 步骤最多运行 60 分钟，review job 最多运行 75 分钟，为审查前的准备和审查后的结果上传留出时间。该机制只重试可识别的瞬时错误，不会把凭证、模型不存在、配额耗尽或账单错误伪装成成功；所有重试耗尽后仍会失败并由 publisher 保留工作稿。若仍频繁出现容量错误，应检查 `REVIEW_AGENT_BASE_URL` 的网关容量或切换模型/Provisioned Throughput，不能无限增加重试次数。

发布统一采用 fail soft：公共输入校验失败停止全部写入；校验通过后，正文、每条 finding、请求回复、每个 thread 的状态同步和证据回复各自执行，异常只阻断依赖该操作的后续步骤。查询失败不能当作空列表继续写入。正文与 finding 分开请求，避免一条无效行号使全部结果无法发布；失效的历史 thread 也不影响其他结果。工作稿上传与发布按实际前置依赖编排，上传失败不阻断已经准备好的 GitHub 写入。

`review-publication-<run>-<attempt>` artifact 中的 `publication-report.json` 在摘要与 coverage 写入后保存，记录发布操作及依赖、结果和错误，也包含这两个出口的结果。Actions 摘要记录此前的 GitHub 操作；进程日志最后汇总全部操作，包括报告自身的存储结果和存储失败后的 coverage 回写结果。任一操作失败或被前置失败阻断，publisher 在完成其余操作后以非零状态结束，coverage 保持 `draft`，完整 audit checkpoint 不推进。报告存储失败同样使 publisher 失败。正文中的历史状态是审查判断，实际执行结果以运行报告为准。

同一运行重跑时，publisher 完整分页读取本 bot 发布的标记，复用已发布的正文、finding 和回复；正文中的执行说明按本次结果更新，resolve/reopen 重新核对远端状态。标记绑定运行、目标 PR、head、操作及内容。写请求报错可能意味着远端已生效，本轮不盲目重试；下次先核对标记。GitHub 写入与网络响应并非原子事务，远端尚不可见时无法保证恰好一次发布。

### 评论请求、范围与历史

评论进入中央 workflow 时只携带评论正文和身份，不携带固定 base/head；workflow 在实际开始时读取当前 PR 快照并固定本轮比较起点。评论任务不会拿不存在的旧 SHA 做快照校验；自动 `pull_request` 事件才会在排队后校验原始 base/head，过时就显式失败。runner 在普通失败路径上尽可能上传已有工作稿；硬中断不承诺保存。评论事件正文保存完整原文。

中央任务把原文交给 Agent 判断范围，优先级是“显式自然语言范围 > thread 隐含范围 > PR 默认规则”。普通 PR 评论重新调查最近一次 PR 级请求的实际范围：即使没有代码变化也重新给出当前证据；有变化则审查新增变化和直接影响，并补齐上次失败或未完成的覆盖。thread 默认调查当前问题及直接影响，只有原文明确要求全 PR 才扩大，且不继承 PR 级范围历史。默认 scope 与可复用 workspace 由可信准备代码初始化；Agent 仅在范围变化时调用 `set_review_scope`，并更新 `review-progress.json` 中的文件进度。可信代码负责请求身份、batch 汇总和最终 `review-coverage.json` 历史记录。最终结果自动使用本轮 scope，无须复制 ID。

同一 PR 的最近 PR 级请求工作稿按控制仓库 Actions artifact 的 repository ID、PR、source、run 和 attempt 查找，不依赖 ancestor/base 关系；失败、跳过发布和草稿都可作为范围历史，排除 thread 工作稿和当前运行。查找不到、artifact 过期或 GitHub 接口错误分别记录，不能把错误当成“无历史”而改变范围。历史工作稿只读。成功的完整 `audit` checkpoint 仍需独立的成功 Check、提交关系和 base/head 校验；局部成功不能推进它。

### 同 PR 并发队列

中央 workflow 在 workflow 级使用 `repository_id` 与 `pull_number` 组成 concurrency group，Review 与 publish 共享同一槽位；不同 PR 可以并行。配置为 `queue: max` 和 `cancel-in-progress: false`：同一 PR 最多一个运行中的任务，最多 100 个 pending 任务，队列满后 GitHub 会取消新增任务。FIFO 依据任务开始等待的时间，不保证 webhook 发出时间的绝对顺序。详见 [GitHub Actions concurrency 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

Review footer 链接工作稿 Actions artifact，保留期以 workflow 的 `retention-days` 为准；访问者必须登录且拥有中央仓库权限。Check Run 的 `details_url` 指向中央仓库当前 `${GITHUB_RUN_ID}`。GitHub known issue 查询使用中央 Skill 和只读 `gh`。

如果 Review 发布失败，先检查：

1. Review App 是否安装到目标仓库和需要读取的关联仓库；
2. App 是否包含 `Issues: read`、`Pull requests: write` 和 `Contents: read and write`，且安装已接受最新权限；
3. Actions secret 中的 private key 是否属于该 App；
4. review job 的 `github_token` 是否仍绑定只读 token，且 write token 只进入 publish job；
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
