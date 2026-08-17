# 部署中央 PR 审计

完成代码合并后，需要仓库管理员执行以下一次性操作。

## 1. 创建 Dispatcher App

在 Qiyin-Tech 组织创建 `Qiyin Agentic Review Dispatcher`：

- Webhook：关闭；
- Repository permissions：`Actions: Read and write`，其余均为 `No access`；
- 安装范围：Only select repositories，仅选择 `Qiyin-Tech/agentic-review`。

记录 Client ID 并生成 private key。GitHub 下载的是 PKCS#1，Cloudflare Web Crypto 需要 PKCS#8：

```bash
openssl pkcs8 -topk8 -nocrypt \
  -in dispatcher.private-key.pem \
  -out dispatcher.private-key.pkcs8.pem
```

## 2. 部署 Cloudflare Worker

在本仓库根目录登录并配置 secret：

```bash
pnpm dlx wrangler@4.123.0 login
pnpm dlx wrangler@4.123.0 secret put WEBHOOK_SECRET
pnpm dlx wrangler@4.123.0 secret put DISPATCH_CLIENT_ID
pnpm dlx wrangler@4.123.0 secret put DISPATCH_PRIVATE_KEY_PKCS8
pnpm dlx wrangler@4.123.0 deploy
```

- `WEBHOOK_SECRET`：自行生成的随机值，例如 `openssl rand -hex 32`；
- `DISPATCH_CLIENT_ID`：上一步的 Client ID；
- `DISPATCH_PRIVATE_KEY_PKCS8`：PKCS#8 PEM 的完整内容。

记录 Wrangler 返回的 `https://...workers.dev` URL。

## 3. 创建 Review App

创建 `Qiyin Agentic Review`：

- Webhook URL：上一步 Worker URL；
- Webhook secret：与 Worker 的 `WEBHOOK_SECRET` 相同；
- 订阅事件：`Pull request`；
- Repository permissions：
  - Metadata: read；
  - Contents: read；
  - Actions: read；
  - Checks: read and write；
  - Pull requests: read and write；
- 安装到需要审查的 Qiyin-Tech 仓库，首批至少包含 `agentic-review`。

记录 Client ID 并生成 private key。在 `Qiyin-Tech/agentic-review` Actions 中配置：

- Repository variable `AGENTIC_REVIEW_CLIENT_ID`：Review App Client ID；
- Repository secret `AGENTIC_REVIEW_APP_PRIVATE_KEY`：原始 PEM 完整内容；
- 继续保留 `REVIEW_AGENT_API_KEY`、`REVIEW_AGENT_MODEL`、`REVIEW_AGENT_BASE_URL`。

## 4. 建立合并门禁

Review App 至少成功创建一次 `Agentic Review / audit` Check 后，在组织或仓库 Ruleset 中：

1. 将 `Agentic Review / audit` 设为 required status check；
2. Expected source 选择 `Qiyin Agentic Review`；
3. 开启 `Require conversation resolution before merging`；
4. Ruleset 的目标 ref 由各仓库治理策略决定，Engine 不假设分支名称。

首次上线可先用 Ruleset Evaluate 模式观察，再切换 Active。缺失、运行中或失败的 Check 都会保持不可合并。
