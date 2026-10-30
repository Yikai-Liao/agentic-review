# 飞书 App 与授权用户操作手册

当前中央 Review 暂停飞书取证与判断，不消费以下授权或工具；token 授权和自动续期继续保留。本手册用于维护者本地验证、维护续期链路，以及以后恢复读取。

本文供中央仓库维护者首次接入、更换飞书 App 或交接授权用户时使用。需要在本机运行命令时，从本仓库根目录执行；密钥写入本机 `.env` 或 GitHub Secret，不发到聊天、PR 或日志中。

## 先理解要关联的是什么

App ID / App Secret 标识应用，应用后台的只读权限决定它可以申请哪些 API 能力。**你本人在 OAuth 页面确认授权，才把应用关联到一个具体的飞书企业用户身份。** 此后飞书按该身份的文档权限判断每次读取能否成功。

授权不是只针对测试时提供的一张表。应用可读范围是「应用已开通且用户已同意的 API scope」与「授权企业用户身份的资料权限」的交集。恢复读取后的 Review 行为由 `central/lark-context.md` 规定，不是 OAuth 对单篇文档的隔离。

同一手机号下切换企业可能是不同用户身份。授权时选能打开目标资料的企业，验收时核对返回的 `name`、`open_id`、`tenant_key`，不要只看显示姓名。

## 首次接入：你和维护会话各做什么

| 步骤 | 你需要做的事 | 维护会话或 workflow 做的事 | 完成标志 |
|---|---|---|---|
| 1. 准备应用 | 创建专用飞书应用，开通用户只读权限并发布；可用范围包含授权用户 | 按[部署说明](deploy-central-review.md#创建飞书应用)核对 scope | 应用已发布，用户可授权 |
| 2. 提供配置 | 在本机 `.env` 填写 `APP_ID`、`APP_SECRET`，提供允许测试的 Docx/Wiki/Base 链接 | 读取配置，不输出密钥；准备固定版本 CLI | 配置可用 |
| 3. 关联用户 | 打开本轮生成的飞书链接，选择企业身份并同意；告诉维护会话已授权 | 领取本轮 device flow 结果 | 登录成功，所需 scope 没有缺失 |
| 4. 验证资料 | 确认返回的是预期账号和测试资料 | 用 `--as user` 读取正文或少量表格记录 | 实际返回预期内容 |
| 5. 接入 Actions | 准备专用 GitHub Rotator App，配置管理员侧凭证 | 按部署说明配置 Environment Secrets，并由默认分支 workflow 发起生产授权 | 生产授权和一次续期均成功 |

只把 `APP_ID`、`APP_SECRET` 写进 `.env` 不会自动登录，也不会同步到 GitHub。本地 OAuth 成功不代表 Actions 已接入；生产授权需要按下面的 Actions 步骤完成。

## 本地验证：已有 `.env` 时照着执行

这一步用于维护者测试，不在 Review Agent 中运行。以下命令适用于 Linux x86_64（与 Actions 相同），需要 Node.js 24、curl、tar、sha256sum、awk，以及可访问 GitHub 和飞书的网络。`.env` 内容如下，其中占位值替换为真实配置；本仓库已忽略 `.env`：

```dotenv
APP_ID=cli_你的应用ID
APP_SECRET=你的应用密钥
```

### 1. 准备 CLI 和独立配置目录

```bash
set -euo pipefail
chmod 600 .env
lark_cli_version="$(awk '$1 == "LARK_CLI_VERSION:" { print $2 }' .github/workflows/agentic-review.yml)"
lark_cli_sha256="$(awk '$1 == "LARK_CLI_SHA256_LINUX_AMD64:" { print $2 }' .github/workflows/agentic-review.yml)"
lark_cli_dir="$(mktemp -d)"
lark_cli_archive="lark-cli-$lark_cli_version-linux-amd64.tar.gz"
curl --fail --location --silent --show-error \
  "https://github.com/larksuite/cli/releases/download/v$lark_cli_version/$lark_cli_archive" \
  --output "$lark_cli_dir/$lark_cli_archive"
echo "$lark_cli_sha256  $lark_cli_dir/$lark_cli_archive" | sha256sum --check --strict
tar --extract --gzip --file "$lark_cli_dir/$lark_cli_archive" --directory "$lark_cli_dir" lark-cli
export PATH="$lark_cli_dir:$PATH"
lark-cli --version
export LARKSUITE_CLI_CONFIG_DIR="$(mktemp -d)"
```

版本和预期 SHA-256 均读取当前可信 checkout 的 `.github/workflows/agentic-review.yml`，手动准备官方归档并执行完整性校验，当前 Review 不安装或恢复 CLI；校验失败必须停止，不能解压执行或继续输入凭证。即使本机已有同版本 CLI，也使用本次校验后解压的文件，版本号本身不证明完整性。其他操作系统或架构需先确定对应发布物及可信校验值，不能套用 Linux 归档或跳过校验。官方 CLI 安装与认证说明见 [larksuite/cli](https://github.com/larksuite/cli/tree/v1.0.88#readme)。

后续命令使用同一个终端及配置目录，避免覆盖其他 CLI 身份。此目录会包含本地凭证，不提交、不上传为 Actions cache。不要在这个终端设置 `LARKSUITE_CLI_USER_ACCESS_TOKEN` 等外部凭证变量，否则 CLI 的 `auth` 管理命令不可用。

### 2. 将 `.env` 中的应用绑定到 CLI

```bash
node --env-file=.env -p 'process.env.APP_SECRET' \
  | lark-cli config init \
      --app-id "$(node --env-file=.env -p 'process.env.APP_ID')" \
      --app-secret-stdin --brand feishu
```

App Secret 经 stdin 输入，避免出现在进程参数中。`.env` 由 Node 解析，不用 `source .env` 执行文件内容。先确认两个字段均已填写，且终端没有覆盖它们的同名环境变量。

### 3. 发起你本人的授权

从生产脚本读取唯一的 scope 清单：

```bash
lark_scopes="$(node --input-type=module -e 'import { larkScopes } from "./scripts/refresh-lark-user-token.ts"; process.stdout.write(larkScopes)')"
lark-cli auth login --scope "$lark_scopes" --no-wait --json
```

打开返回的 `verification_url`，用预期用户及企业身份确认授权。由维护 Agent 执行时，Agent 先把链接发给用户并结束当前回合；用户回复已完成后，再由同一个维护会话执行：

```bash
lark-cli auth login --device-code '<本轮返回的 device_code>' --json
```

成功响应应没有缺失的所需 scope。授权链接和 device code 有效期以本轮响应为准；过期后重新发起，不复用旧链接。提供给维护会话的测试表格不是 OAuth 的唯一可读对象。

### 4. 验证用户身份和实际读取

```bash
lark-cli api GET /open-apis/authen/v1/user_info --as user --format json \
  --jq '.data | {name, open_id, tenant_key}'

lark-cli docs +fetch --as user --doc '<Docx 或 Wiki 完整 URL>' \
  --scope outline --max-depth 3 --doc-format markdown
```

多维表格先按 URL 取得 Base token、table ID 和 view ID，再查字段：

```bash
lark-cli base +url-resolve --as user --url '<Base 完整 URL>' --format json
lark-cli base +field-list --as user --base-token '<BASE_TOKEN>' \
  --table-id '<TABLE_ID>' --format json
lark-cli base +record-list --as user --base-token '<BASE_TOKEN>' \
  --table-id '<TABLE_ID>' --view-id '<VIEW_ID>' \
  --field-id '<编号字段 ID>' --field-id '<标题字段 ID>' --field-id '<状态字段 ID>' \
  --limit 3 --format json
```

URL 没有指定 view 时省略 `--view-id`。字段使用上一条命令返回的真实 ID。只验证少量记录，不扫描整表；能列出字段不等于能读记录，返回空也不证明权限完整。

## 接入 Actions 自动续期

生产配置以[部署说明第 4 节](deploy-central-review.md#4-飞书用户-oauth-与自动续期)为准：创建两个 Environment、配置专用 Rotator GitHub App，并把 App ID 和长期凭证放到对应位置。不要复制本地 CLI 的登录目录或 refresh token 给 Actions，两端不得消费同一条续期链路。

workflow 必须已合入默认分支。首次接入或切换用户均由默认分支重新授权：

```bash
gh api --method POST repos/Qiyin-Tech/agentic-review/dispatches \
  -f event_type=authorize-lark-user
```

打开 Actions → **Refresh Lark User Token** → 当前运行 → **Refresh and rotate Lark user token** 日志中的飞书链接，使用预期账号确认。此轮由 workflow 自动领取结果并保存 token，不再在本地执行 `--device-code`。

确认运行成功、两项 Environment token Secret 的更新时间已变化后，发送 `refresh-lark-user` 事件，确认续期也成功，即完成当前保留的 Actions 授权和续期接入。中央 Review 暂不读取资料；以后恢复读取时，再按部署说明触发含相关链接的 Review，核对实际读取证据。

## 更换飞书 App 或用户

| 要换什么 | 需要更新什么 | 是否重新用户授权 |
|---|---|---|
| 只换用户或企业身份，App 不变 | 保留 App ID / Secret，替换整对用户 token | 是，由新用户在预期企业身份下确认 |
| 换 App，用户不变或同时更换 | 新 App 的用户只读权限、可用范围、App ID、App Secret、整对用户 token | 是，旧 token 不能搭配新 App |
| 只修改可见文档范围 | 向当前授权身份共享资料；更新下游来源声明 | scope 已足够时不需要重新登录 |
| 增加所需 API scope | 应用开通并发布权限，随后重新授权 | 是，仅更新应用权限不等于用户已经同意 |

### 1. 先验证新组合

新 App 或用户按上面的本地流程，在新配置目录中完成授权和代表性资料读取。记录预期的用户及企业标识；不要把旧用户能读取的结果当成新用户验证结果。只换飞书 App/用户时，已有 Rotator GitHub App 可以继续使用。

### 2. 暂停生产任务，等待旧任务结束

当前中央 Review 不消费飞书凭据，更换 App/用户只需暂停续期 workflow。以下中央 Review 停启命令仅在以后恢复飞书读取后适用。安排维护窗口，暂停相应任务：

```bash
gh workflow disable agentic-review.yml --repo Qiyin-Tech/agentic-review
gh workflow disable lark-token-refresh.yml --repo Qiyin-Tech/agentic-review
gh run list --repo Qiyin-Tech/agentic-review --workflow agentic-review.yml
gh run list --repo Qiyin-Tech/agentic-review --workflow lark-token-refresh.yml
```

在 Actions 页面确认所有已排队、等待和运行中的旧任务都已结束，再修改凭证。禁用 workflow 只阻止新触发，不代表旧任务已结束；不要在兑换 refresh token 中途取消续期。维护期间漏掉的 Review 触发需在恢复后补跑。GitHub 的停启操作见[官方说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)。

### 3. 替换配置并移除旧 token

仅换用户时跳过 App 配置更新；换 App 时，按部署说明更新 `AGENTIC_REVIEW_LARK_APP_ID` 和 `lark-rotation` 中的 `AGENTIC_REVIEW_LARK_APP_SECRET`。修改本机 `.env` 不会更新它们。

在 GitHub 的两个 Environment 中删除旧 token，避免新 App 配旧 refresh token，或授权失败后继续沿用旧用户：

```bash
gh secret delete AGENTIC_REVIEW_LARK_REFRESH_TOKEN --env lark-rotation --repo Qiyin-Tech/agentic-review
gh secret delete AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN --env lark-review --repo Qiyin-Tech/agentic-review
```

这两项删除后不能从 GitHub 取回，恢复旧身份也需要重新授权；长期 App 配置和 Rotator 配置不删除。

### 4. 重新授权，恢复运行

启用续期 workflow 后，立即发起 `authorize-lark-user`，由新用户确认。授权完成前恰好触发的定时续期会因缺少 refresh token 明确失败，不代表授权事件失败。

```bash
gh workflow enable lark-token-refresh.yml --repo Qiyin-Tech/agentic-review
gh api --method POST repos/Qiyin-Tech/agentic-review/dispatches -f event_type=authorize-lark-user
```

确认授权和一次 `refresh-lark-user` 续期都成功，即完成当前轮换。若此前已恢复飞书读取并在维护时停用了 Review，再执行：

```bash
gh workflow enable agentic-review.yml --repo Qiyin-Tech/agentic-review
```

飞书读取启用后，补跑测试 Review，确认身份、文档和记录均符合预期。该验收失败时保持飞书读取停用并解决配置、scope 或共享问题；不要回填过期 token。需要回到旧 App/用户时，恢复对应 App 配置，再由旧用户重新授权。交接结束后由旧用户在飞书侧撤销不再需要的应用授权；本地 `auth logout` 不能代替服务端撤销。

## 常见卡点

- **填了 `.env`，但没关联我的文档**：还没完成用户 OAuth；App 凭证本身不代表你。
- **只授权了一张测试表吗**：不是；表链接用于验收，OAuth 授予的是用户身份下的 API 能力。
- **姓名正确但文档无权读取**：核对企业身份、文档共享和表格行列权限；显示姓名相同不够。
- **本地读取成功，Actions 仍失败**：检查 GitHub 配置及生产授权；本地登录不会同步到 Actions。
- **切换 App 后 refresh 失败**：检查是否仍在使用旧 App 的 refresh token，必须重新授权生成一对新 token。
- **授权链接已过期**：重新发起对应本地登录或 `authorize-lark-user` 事件，打开新链接。
