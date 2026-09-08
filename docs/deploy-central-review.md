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
- `ALLOWED_OWNER=目标 owner`。

```bash
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put WEBHOOK_SECRET
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_CLIENT_ID
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_PRIVATE_KEY_PKCS8
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml deploy
```

## 3. Review App 与中央仓库

创建 Review GitHub App，开启 Pull request webhook，并安装到所有目标仓库、需要查询的同 owner 关联仓库以及中央仓库。App repository permissions 至少为：

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

### 登录状态保存在哪里

Actions runner 每轮都是新机器。持久化的是 OAuth token，CLI 每轮通过环境变量使用 UAT；不缓存 CLI 登录目录，不在 Review 中执行 `auth login`。一个授权企业用户身份对应一条续期链路：

```text
你在浏览器授权飞书应用（所需只读 scope + offline_access）
  → 可信续期 job 得到 UAT 和 refresh token
  → lark-rotation Environment 保存 refresh token
  → lark-review Environment 保存 UAT
  → Review job 启动时读取 UAT，注入 LARKSUITE_CLI_USER_ACCESS_TOKEN
  → 官方 lark-cli --as user 读取指定资料
```

定时任务独占 refresh token 并先保存下一代 refresh token，再发布 UAT。App Secret 和写 Environment Secret 的 GitHub token 只在续期 job 中使用，Review 的 `GH_TOKEN` 仍然只读。

### 创建飞书应用

1. 打开[飞书开放平台开发者后台](https://open.feishu.cn/app)，创建企业自建应用，例如 `Agentic Review`。当前方案不使用机器人能力，也不需要 OAuth 回调或 persistent runner。
2. 为**用户身份**申请 `offline_access` 和以下只读 scope：
   - `search:docs:read`：搜索用户可见的文档/Wiki；
   - `docx:document:readonly`：读取文档正文；
   - `wiki:node:retrieve`：解析 Wiki 节点和 space ID；
   - `drive:drive.metadata:readonly`：读取文档元数据；
   - `base:app:read`、`base:table:read`、`base:field:read`、`base:record:read`：读取多维表格结构与 Issue 记录。
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
| `lark-review` | `AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN` | Review job |

[GitHub 在 workflow 排队时读取 Repository Secret，在 job 启动时读取 Environment Secret](https://docs.github.com/en/actions/reference/security/secrets#when-github-actions-reads-secrets)。因此动态 token 必须使用上述 Environment Secret，续期锁设在 job 层，避免排队任务拿到已消费的旧 refresh token，也避免排队的 Review 固定旧 UAT。不要另存同名 Repository Secret。

### 首次授权维护者账号

PR 合并后，使用有权操作中央仓库的维护者 GitHub 账号执行：

```bash
gh api --method POST repos/Qiyin-Tech/agentic-review/dispatches \
  -f event_type=authorize-lark-user
```

`repository_dispatch` 只加载默认分支上的可信 workflow，避免误选 PR branch 执行持有中央凭证的代码。立即打开 **Refresh Lark User Token** 运行日志中的飞书验证 URL，使用维护者本人账号确认授权。workflow 通过飞书 device flow 取得 UAT 与单次 refresh token，并直接创建：

- `AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN`；
- `AGENTIC_REVIEW_LARK_REFRESH_TOKEN`。

授权时选择需要用于读取的企业身份；成功后确认 workflow 为成功状态、两个 Environment 中都已创建 token secret。首次授权前启动 Review 会明确因缺少凭证失败。

之后 workflow 每小时串行刷新一次。OAuth 请求只消费一次 refresh token；Secret 写入才对同一值最多重试五次，不重新兑换 token。定时调度不保证准点执行，token 的有效期以 OAuth 响应和运行日志为准；这是一条自动续期链路，不是永不过期的登录。

UAT 过期但 refresh token 仍有效、或新 refresh token 已保存而 UAT 写入失败时，发送一个**新**的刷新事件：

```bash
gh api --method POST repos/Qiyin-Tech/agentic-review/dispatches \
  -f event_type=refresh-lark-user
```

授权撤销、refresh token 失效、或新 refresh token 在保存成功前因写入失败/runner 终止而丢失时，重新发送 `authorize-lark-user` 并确认授权。Secret 重试不能保证跨飞书和 GitHub 的事务原子性；新 refresh token 丢失后无法由旧值恢复。不要复制旧 token 或把失败改成成功，也不要并行在本地消费这条续期链路。

### 验证主企业与三个子企业

可读范围是**应用已开通的用户 scope ∩ 用户已同意的 scope ∩ 当前企业用户身份的文档/表格权限**。用户 OAuth 不要求逐篇“添加文档应用”；文档所有者需要把资料共享给授权的那个用户身份。

同一手机号切换企业不代表同一个 OAuth 身份，不能保证一个 UAT 覆盖主企业和三个子企业。分别选择代表性 Docx、Wiki 和 Base，先在授权时选择的企业身份下确认共享，再实际通过 API 读取；跨租户共享策略和接口支持仍可能限制访问。需要切换身份才能看到的资料，须先解决共享或另行设计多身份接入，本 PR 不承诺跨企业自动通读。

Review job 的 `Verify Lark user token` 通过 `lark-cli api GET /open-apis/authen/v1/user_info --as user` 验证当前 UAT，并校验成功响应。它只证明登录有效，不证明文档权限；外部 token 模式下 CLI 禁用 `auth` 管理命令，不能用 `auth check` 或 `auth status` 验收。

把测试来源及真实触发条件先合并进下游 `.agentic-review.md`，再用会触发该查询的测试 PR 验收：工作稿应包含 `docs +fetch` 的相关正文、Wiki 解析后的读取结果，以及 Base 的表、字段和目标记录原值。登录检查成功或 Review 总体成功都不能替代这些实际读取证据。权限错误按层处理：缺 scope 时在应用后台开通、发布并重新用户授权；文档 ACL 不足时向授权身份共享；Base 记录缺失时检查该用户角色的行列权限。

高级权限 Base 同样遵守该用户所属角色的表、字段和记录范围。Lark CLI 不会越过用户 ACL；Figma 等第三方 iframe 仍只能取得飞书返回的链接或占位元数据。

### 下游规则

在下游仓库 `.agentic-review.md` 逐条写清楚完整 URL、触发查询的路径/业务对象，以及多维表格的 Issue 表、关键字段和状态语义。例如：

```markdown
## 飞书 Known issues

- 修改订单、支付或退款状态时，按需查询退款 PRD
  `https://example.feishu.cn/wiki/wikcnRefundPRD`、验收记录
  `https://example.feishu.cn/docx/doxcnRefundQA` 和 Issue 表
  `https://example.feishu.cn/base/bascnIssues?table=tblIssues`；其他变更不读取。
- Issue 表的“已排期”只表示计划中；“已验收”或正文中的验收结论才表示已修复。
```

先合并规则；当前 PR 新增的飞书 URL 或搜索范围不会在同一轮被读取。Agent 只在形成候选 finding 后读取已声明来源，并对 Base 使用服务端筛选和最小字段投影。

## 5. Review 发布权限验证

每次中央 workflow 会 mint 三个 installation token：

| Token | 仓库范围 | 用途 | 权限 |
|---|---|---|---|
| read token | 目标 owner 中安装了 Review App 的仓库 | checkout、shaftoe action、`GH_TOKEN`、Pi bash 的 `gh` | `contents: read`、`issues: read`、`pull_requests: read`、`actions: read`、`checks: read` |
| check token | 仅当前目标仓库 | Agent 启动前创建关联当前 Action Run 的 Check | `checks: write` |
| publication token | 仅当前目标仓库 | 隔离的可信 publish job | `contents: write`、`pull_requests: write`、`checks: write` |

可信 workflow 在 Agent 启动前将 read token 的可读集合固定为目标 owner 中安装了 Review App 的仓库；目标 PR 不能增加仓库或权限。在这个固定集合内，workflow 自动关联索引，或 `.agentic-review.md` 等审查输入中的明确稳定 Issue/PR 引用，可以选择尚未在 merge base 声明的私有记录供 Agent 按需读取；这是既定产品边界，不需要 merge-base 预授权。关联只建立查询入口，不证明候选相关性或业务授权。Agent 按 PR head 理解预期合并后的项目状态语义，只在当前 finding 确有需要时查询。单个 installation token 不能跨 GitHub owner，其他 owner 的私有仓库需要单独的 installation/token 设计。

`check token` 在 Pi 启动前创建 Check；`publication token` 在 Pi 结束后完成 Check，并统一创建 Review、回复当前 PR 历史 thread 和 resolve/reopen。GitHub GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 除 `pull_requests: write` 外实际还要求 `contents: write`；该高权限 token 不进入 Agent shell，也不进入 review job。自定义 `submit_review` 扩展本身不读取 token，只封存 Review 工作区内的最终 JSON；可信步骤校验结果后发布到本轮审查的 head。新快照按同一 PR 串行等待，下一轮 Review 会读取旧结果并更新对应 thread。Review footer 链接工作稿 Actions artifact，保留期以 workflow 的 `retention-days` 为准；访问者必须登录且拥有中央仓库权限。Check Run 的 `details_url` 指向中央仓库当前 `${GITHUB_RUN_ID}`。GitHub known issue 查询使用中央 Skill 和只读 `gh`。

如果 Review 发布失败，先检查：

1. Review App 是否安装到目标仓库和需要读取的关联仓库；
2. App 是否包含 `Issues: read`、`Pull requests: write` 和 `Contents: read and write`，且安装已接受最新权限；
3. Actions secret 中的 private key 是否属于该 App；
4. review job 的 `github_token` 是否仍绑定只读 token，且 write token 只进入 publish job；
5. publisher 使用的 `repository`、`pull_number` 和 base/head SHA 是否来自 webhook dispatch input。

## 6. 验证

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm dlx wrangler@4.123.0 deploy --dry-run
```

用一个测试 PR 确认中央 workflow 日志中：Agent 的 `gh` 使用 read token，最后创建了一个 GitHub Pull Request Review，而不是普通 issue comment。
