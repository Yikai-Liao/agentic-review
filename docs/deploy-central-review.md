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

`check token` 在 Pi 启动前创建 Check；publisher 在可信 completion 之前重新校验结果 schema、scope、请求身份、root comment 和 bot ownership，成功发布 Review、回复当前 PR 历史 thread 和执行允许的 resolve/reopen 后，completion 才能标记成功。GraphQL 的 `resolveReviewThread`/`unresolveReviewThread` 除 `pull_requests: write` 外实际还要求 `contents: write`；该高权限 token 不进入 Agent shell，也不进入 review job。自动 resolve/reopen 只接受由该 Review App 创建的 bot-owned root thread；人工 root 可以收到可信 publisher 的回复，但不会被自动改变 resolved 状态。自定义 `submit_review` 扩展本身不读取 token，只封存 Review 工作区内的最终 JSON；失败不能推进完整 audit checkpoint。

### 评论请求、范围与历史

评论进入中央 workflow 时只携带评论正文和身份，不携带固定 base/head；workflow 在实际开始时读取当前 PR 快照并固定本轮比较起点。评论任务不会拿不存在的旧 SHA 做快照校验；自动 `pull_request` 事件才会在排队后校验原始 base/head，过时就显式失败。runner 在普通失败路径上尽可能上传已有工作稿；硬中断不承诺保存。评论事件正文保存完整原文。

中央任务把原文交给 Agent 判断范围，优先级是“显式自然语言范围 > thread 隐含范围 > PR 默认规则”。普通 PR 评论重新调查最近一次 PR 级请求的实际范围：即使没有代码变化也重新给出当前证据；有变化则审查新增变化和直接影响，并补齐上次失败或未完成的覆盖。thread 默认调查当前问题及直接影响，只有原文明确要求全 PR 才扩大，且不继承 PR 级范围历史。范围和 batch 覆盖写入 `review-coverage.json`，最终结果的 `scope_id` 必须与 `set_review_scope` 写入的 scope 一致。

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

## 5. 验证

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm dlx wrangler@4.123.0 deploy --dry-run
```

用一个测试 PR 确认中央 workflow 日志中：Agent 的 `gh` 使用 read token，最后创建了一个 GitHub Pull Request Review，而不是普通 issue comment。
