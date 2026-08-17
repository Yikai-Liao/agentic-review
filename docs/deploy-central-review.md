# 部署中央 PR 审计

以下步骤适用于任意 GitHub organization 与 Cloudflare account。尖括号内容必须替换为当前部署值；组织、仓库、分支、域名不得写入 Worker 源码或版本控制中的 `wrangler.toml`。

## 1. 创建 Dispatcher App

在控制仓库所属 organization 创建 Dispatcher GitHub App：

- Webhook：关闭；
- Repository permissions：`Actions: Read and write`，其余均为 `No access`；
- 安装范围：Only select repositories，仅选择 `<control-owner>/<control-repository>`。

记录 Client ID 并生成 private key。GitHub 下载的是 PKCS#1，Cloudflare Web Crypto 需要 PKCS#8：

```bash
openssl pkcs8 -topk8 -nocrypt \
  -in dispatcher.private-key.pem \
  -out dispatcher.private-key.pkcs8.pem
```

## 2. 配置并部署 Worker

复制 `worker/README.md` 中的示例，创建 gitignored 的 `wrangler.local.toml`，配置：

- Cloudflare `account_id`；
- Worker 名称与可选 custom domain；
- `CONTROL_REPOSITORY=<owner>/<repository>`；
- `ALLOWED_OWNER=<允许审查的 owner>`。

Worker 会通过 GitHub API 获取控制仓库的默认分支，不要求分支名。

然后登录并配置 secrets：

```bash
pnpm dlx wrangler@4.123.0 login
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put WEBHOOK_SECRET
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_CLIENT_ID
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml secret put DISPATCH_PRIVATE_KEY_PKCS8
pnpm dlx wrangler@4.123.0 --config wrangler.local.toml deploy
```

- `WEBHOOK_SECRET`：自行生成的随机值，例如 `openssl rand -hex 32`；
- `DISPATCH_CLIENT_ID`：Dispatcher App Client ID；
- `DISPATCH_PRIVATE_KEY_PKCS8`：PKCS#8 PEM 完整内容。

记录 Worker 的 HTTPS URL。

## 3. 创建 Review App

在目标 organization 创建 Review GitHub App：

- Webhook URL：Worker HTTPS URL；
- Webhook secret：与 Worker 的 `WEBHOOK_SECRET` 相同；
- 订阅事件：`Pull request`；
- Repository permissions：
  - Metadata: read；
  - Contents: read；
  - Actions: read；
  - Checks: read and write；
  - Pull requests: read and write。

安装到需要审查的仓库，至少包含控制仓库。记录 Client ID 并生成 private key。在控制仓库 Actions 中配置：

- Repository variable `AGENTIC_REVIEW_CLIENT_ID`：Review App Client ID；
- Repository secret `AGENTIC_REVIEW_APP_PRIVATE_KEY`：原始 PEM 完整内容；
- `REVIEW_AGENT_API_KEY`、`REVIEW_AGENT_MODEL`、`REVIEW_AGENT_BASE_URL`。

## 4. 建立合并门禁

Review App 至少成功创建一次 `Agentic Review / audit` Check 后，在 organization 或 repository Ruleset 中：

1. 将 `Agentic Review / audit` 设为 required status check；
2. Expected source 选择 Review App；
3. 开启 `Require conversation resolution before merging`；
4. Ruleset 的目标 ref 由各仓库治理策略决定，Engine 不假设分支名称。

首次上线可先用 Ruleset Evaluate 模式观察，再切换 Active。缺失、运行中或失败的 Check 都会保持不可合并。
