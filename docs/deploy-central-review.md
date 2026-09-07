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
- `REVIEW_AGENT_BASE_URL`：OpenAI-compatible gateway 地址。

中央仓库 Actions secrets：

- `AGENTIC_REVIEW_APP_PRIVATE_KEY`：Review App private key；
- `REVIEW_AGENT_API_KEY`：模型 API key。

不要把上述 secrets 配到目标仓库。目标仓库不需要 `.github/workflows/review.yml`。

## 4. Review 发布权限验证

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

## 5. 验证

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm dlx wrangler@4.123.0 deploy --dry-run
```

用一个测试 PR 确认中央 workflow 日志中：Agent 的 `gh` 使用 read token，最后创建了一个 GitHub Pull Request Review，而不是普通 issue comment。
