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
- `AGENTIC_REVIEW_LARK_APP_ID`：飞书企业自建应用 App ID。

中央仓库 Actions secrets：

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`：Review App private key；
- `REVIEW_AGENT_API_KEY`：模型 API key；
- `AGENTIC_REVIEW_LARK_APP_SECRET`：飞书企业自建应用 App Secret。

不要把上述 secrets 配到目标仓库。目标仓库不需要 `.github/workflows/review.yml`。

## 4. 飞书只读应用与项目授权

### 中央管理员一次性配置

1. 打开[飞书开放平台开发者后台](https://open.feishu.cn/app)，创建**企业自建应用**，例如命名为 `Agentic Review`。无需配置 OAuth 回调，也不使用个人登录。
2. 在“权限管理”申请并只保留以下应用身份（tenant token）只读 scope：
   - `search:docs:read`：在已授权范围搜索文档/Wiki；
   - `docx:document:readonly`：读取文档正文；
   - `wiki:node:retrieve`：从 Wiki URL 解析节点和 space ID；
   - `drive:drive.metadata:readonly`：读取文档元数据。
3. 创建并发布应用版本，按组织流程由飞书管理员审核。应用可用范围至少包含后续负责授权资料的同事；API scope 只决定“能调用什么接口”，还不能读取任何未授予资源权限的文档。
4. 在“凭证与基础信息”复制 App ID 与 App Secret，分别写入中央 GitHub 仓库的 Actions variable `AGENTIC_REVIEW_LARK_APP_ID` 和 secret `AGENTIC_REVIEW_LARK_APP_SECRET`。不要写入下游仓库或 `.agentic-review.md`。
5. 运行一次中央 Review；`Configure read-only Lark CLI` 会校验凭证与四个 scope，缺失时 fail closed。官方 `lark-cli 1.0.88` 二进制按固定 SHA-256 校验，并通过 Actions cache 跨运行复用。

### 项目同事按资料授权

现有文档无需迁移、归档到专用空间或改变目录结构：

1. 打开任意需要授权的 Docx 或 Wiki 文档，在“分享 / 权限设置”中选择“添加文档应用”，找到 `Agentic Review` 并只授予阅读权限。需要授权整个**现有** folder 或 Wiki space 时，才在对应成员设置中加入应用。不同飞书版本的入口文案可能略有差异；搜不到应用时，先确认应用版本已发布、可用范围包含当前操作者且已申请云文档 scope。官方排障见[如何给应用添加云文档权限](https://open.feishu.cn/document/faq/trouble-shooting/how-to-add-permissions-to-app)。
2. 在下游仓库 `.agentic-review.md` 逐条写清楚文档完整 URL、触发查询的路径/业务对象、哪些状态算已修复或已验收。例如：

   ```markdown
   ## 飞书 Known issues

   - 修改订单、支付或退款状态时，按需查询退款 PRD
     `https://example.feishu.cn/wiki/wikcnRefundPRD` 和验收记录
     `https://example.feishu.cn/docx/doxcnRefundQA`；其他变更不读取。
   - “已排期”只表示计划中；正文中的验收结论才表示已修复。
   ```

3. 先合并这份规则。当前 PR 新增的飞书 URL 或搜索范围不会在同一轮被读取，后续 PR 才生效，防止候选代码自行扩大组织文档访问范围。

Agent 只在形成候选 finding 后，直接对已声明文档做关键词/章节读取；仅当 `.agentic-review.md` 明确声明整个现有 Wiki space 或 folder 时才使用范围搜索。飞书文档中的 Figma 等第三方 iframe 只能返回链接/占位元数据，Lark CLI 不会取得 Figma 画布内容；此类信息需要人工提供文本结论，或另行设计独立、最小权限的 Figma 集成。

## 5. Review 发布权限验证

每次中央 workflow 会 mint 三个 installation token：

| Token | 仓库范围 | 用途 | 权限 |
|---|---|---|---|
| read token | 目标 owner 中安装了 Review App 的仓库 | checkout、shaftoe action、`GH_TOKEN`、Pi bash 的 `gh` | `contents: read`、`issues: read`、`pull_requests: read`、`actions: read`、`checks: read` |
| check token | 仅当前目标仓库 | Agent 启动前创建关联当前 Action Run 的 Check | `checks: write` |
| publication token | 仅当前目标仓库 | 隔离的可信 publish job | `contents: write`、`pull_requests: write`、`checks: write` |

下游仓库可以在 `.agentic-review.md` 中用自然语言说明相关仓库、known issue 来源和项目状态语义；Agent 按 PR head 理解预期合并后的语义，只在当前 finding 确有需要时查询。新增私有跨仓库读取范围必须已存在于 merge base；单个 installation token 不能跨 GitHub owner，其他 owner 的私有仓库需要单独的 installation/token 设计。

`check token` 在 Pi 启动前创建 Check；`publication token` 在 Pi 结束后完成 Check，并统一创建 Review、回复当前 PR 历史 thread 和 resolve/reopen。GitHub GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 除 `pull_requests: write` 外实际还要求 `contents: write`；该高权限 token 不进入 Agent shell，也不进入 review job。自定义 `submit_review` 扩展本身不读取 token，只封存 Review 工作区内的最终 JSON；可信步骤校验结果后发布到本轮审查的 head。新快照按同一 PR 串行等待，下一轮 Review 会读取旧结果并更新对应 thread。Review footer 还会链接保留 1 天的工作稿 Actions artifact；访问者必须登录且拥有中央仓库权限。Check Run 的 `details_url` 指向中央仓库当前 `${GITHUB_RUN_ID}`。GitHub known issue 查询使用中央 skills 和只读 `gh`；飞书来源由 `lark-known-issues` skill 通过 bot 身份 Lark CLI 接入同一套 known issue 规则。

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
