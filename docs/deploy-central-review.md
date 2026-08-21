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
- `REVIEW_AGENT_API_KEY`：模型 API key；
- `AGENTIC_REVIEW_LARK_APP_SECRET`：飞书企业自建应用 App Secret；
- `AGENTIC_REVIEW_LARK_ROTATOR_PRIVATE_KEY`：Lark Secret Rotator GitHub App private key；
- `AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN`：当前维护者 user access token；
- `AGENTIC_REVIEW_LARK_REFRESH_TOKEN`：当前单次 refresh token。

不要把上述 secrets 配到目标仓库。目标仓库不需要 `.github/workflows/review.yml`。

## 4. 飞书用户 OAuth 与自动续期

### 创建飞书应用

1. 打开[飞书开放平台开发者后台](https://open.feishu.cn/app)，创建企业自建应用，例如 `Agentic Review`。当前方案不使用机器人能力，也不需要 OAuth 回调或 persistent runner。
2. 为**用户身份**申请 `offline_access` 和以下只读 scope：
   - `search:docs:read`：搜索用户可见的文档/Wiki；
   - `docx:document:readonly`：读取文档正文；
   - `wiki:node:retrieve`：解析 Wiki 节点和 space ID；
   - `drive:drive.metadata:readonly`：读取文档元数据；
   - `base:app:read`、`base:table:read`、`base:field:read`、`base:record:read`：读取多维表格结构与 Issue 记录。
3. 发布应用版本并完成管理员审核。应用可用范围必须包含执行 OAuth 授权的维护者账号。
4. 将 App ID 写入中央仓库 variable `AGENTIC_REVIEW_LARK_APP_ID`，App Secret 写入 secret `AGENTIC_REVIEW_LARK_APP_SECRET`。

### 配置 token 轮换权限

另建一个 `Lark Secret Rotator` GitHub App：关闭 webhook，只授予 `Secrets: read and write`，只安装到中央仓库。将其 Client ID 写入 variable `AGENTIC_REVIEW_LARK_ROTATOR_CLIENT_ID`，private key 写入 secret `AGENTIC_REVIEW_LARK_ROTATOR_PRIVATE_KEY`。该 App 只供 `.github/workflows/lark-token-refresh.yml` 更新两项 Lark token secret，不进入 Review job。

### 首次授权维护者账号

PR 合并后，在中央仓库 Actions 页面手动运行 **Refresh Lark User Token**，将 `authorize` 设为 `true`。立即打开运行日志中的飞书验证 URL，使用维护者本人账号确认授权。workflow 通过飞书 device flow 取得 UAT 与单次 refresh token，并直接创建：

- `AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN`；
- `AGENTIC_REVIEW_LARK_REFRESH_TOKEN`。

之后 workflow 每小时串行刷新一次，先保存新 refresh token，再保存新 UAT，避免并发消费同一代 refresh token。刷新失败会直接使 Action 失败；token 被撤销、过期或需要重新授权时，再手动运行一次 `authorize=true`。

### 验证主企业与三个子企业

当前 Review 绑定维护者账号的真实可见范围，不使用“添加文档应用”。分别在四个企业各选一篇测试 Docx 和一张测试 Base，先确认该账号在飞书客户端中能直接打开，再运行一次 Review 验证读取。子企业之间无需互联；只要资料已共享给该用户，UAT 就沿用相同权限。看不到的资料应在飞书中授权给该用户，不能靠扩大 API scope 修复。

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

下游仓库可以在 `.agentic-review.md` 中用自然语言说明相关仓库、known issue 来源和项目状态语义；Agent 按 PR head 理解预期合并后的语义，只在当前 finding 确有需要时查询。新增私有跨仓库读取范围必须已存在于 merge base；单个 installation token 不能跨 GitHub owner，其他 owner 的私有仓库需要单独的 installation/token 设计。

`check token` 在 Pi 启动前创建 Check；`publication token` 在 Pi 结束后完成 Check，并统一创建 Review、回复当前 PR 历史 thread 和 resolve/reopen。GitHub GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 除 `pull_requests: write` 外实际还要求 `contents: write`；该高权限 token 不进入 Agent shell，也不进入 review job。自定义 `submit_review` 扩展本身不读取 token，只封存 Review 工作区内的最终 JSON；可信步骤校验结果后发布到本轮审查的 head。新快照按同一 PR 串行等待，下一轮 Review 会读取旧结果并更新对应 thread。Review footer 还会链接保留 1 天的工作稿 Actions artifact；访问者必须登录且拥有中央仓库权限。Check Run 的 `details_url` 指向中央仓库当前 `${GITHUB_RUN_ID}`。GitHub known issue 查询使用中央 skills 和只读 `gh`；飞书来源由 `lark-known-issues` skill 通过维护者用户身份 Lark CLI 接入同一套 known issue 规则。

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
