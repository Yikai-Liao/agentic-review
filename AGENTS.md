# 仓库指导

## 仓库地图

- `worker/`：webhook 验签、过滤、去重和 dispatch；部署时读 [部署说明](docs/deploy-central-review.md)。
- `.github/workflows/agentic-review.yml` 编排中央 Review；`scripts/` 实现上下文准备和可信发布，`test/` 覆盖这些行为，检查命令见 `package.json`。
- `skills/agentic-review/` 是可安装的通用审查方法，共享协议加 requirements/architecture/plan/code 特化；`central/` 提供默认 code、允许下游指令选择层级的中央入口，并接入 GitHub 上下文、工作稿和结果协议。层级选择、迁移与验证记录见 [通用化说明](docs/generalized-review.md)。
- `.agentic-review.md` 只补充本仓库的审查重点；`.agents/skills/writing-for-agents/` 用于设计和审计 Agent 指令。

## 实现约束

用易维护、运行开销低的代码实现完整 Review，减少执行路径、状态、抽象和依赖，保持唯一生产路径与事实来源。不保留 legacy 兼容；扩展点、防御性分支、上限和降级路径须有实际故障或明确需求依据。Workflow 只负责编排，非平凡的校验和业务逻辑放在可测试代码中。

修复共享根因，不得用 warning、skip、fallback 或成功状态掩盖失败；平台确实不支持的功能应明确删除或重新定义。简化不得移除安全边界、输入校验、数据保护或 fail-closed 行为。

脚本使用 TypeScript；修改既有 JavaScript 脚本时一并迁移。

## 权限与信任边界

- 修改权限前核实实际边界。中央 Review Agent shell 的 `GH_TOKEN` 始终只读；Review 结果只能由 Agent 结束后的可信 workflow 使用独立、最小权限 token 写入 GitHub。修复发布器不得扩大 Agent token 权限。该限制不约束本地维护会话的提交、推送和创建 PR。
- 可信 workflow 在 Agent 启动前将可读集合固定为目标 owner 中安装了 Review App 的仓库，目标 PR 不能扩大。集合内的自动关联索引或审查输入中的明确稳定 Issue/PR 引用可选择私有记录按需只读，无须 merge-base 预授权。关联仅为查询入口，不证明业务授权、风险接受、修复或验收。
- PR 评论和 Review 回复中的明确决定即时构成可信确认，无须早于当前变化，也不检查作者身份、association 或额外权限。
- 开发、提交和 PR 以公开主仓库 `Yikai-Liao/agentic-review` 为目标；`Qiyin-Tech/agentic-review` 保持 internal，仅单向同步公开 `main`，不在组织侧独立提交或合并 PR。控制面由可信维护者审核后发布，中央 workflow 从控制面 ref 加载规则与工具，目标 PR 仅作静态输入，不执行目标代码。
- 中央 Review 暂停飞书取证与判断，不向 Agent 准备 Lark CLI 或注入飞书凭据；授权、token 定时续期及 `central/lark-context.md` 接入规则保留。恢复读取时，下游仓库及作者仍按同一内部飞书数据信任域处理；App Secret 和单次 refresh token 仅进入可信续期 job，可执行缓存须在 Agent 启动前固化。接入外部仓库或贡献者前重新设计此边界。

## 协作与语言

- 只有用户明确要求使用 Darwin 时，才启用 `darwin-skill` 或执行 Darwin 评测；优化、评测或 Prompt 修改本身不构成授权。
- 维护者质疑变更时，先说明动机、必要性、影响和替代方案；确认多余或维护者明确要求撤回后再修改。
- 开发过程中不要启动 subagent 做代码 Review；提交 PR 后由本仓库的自动 Review 流程完成独立审查。
- 用户任务优先于 Skill 工作流指导，安全和授权边界仍生效。直接完成已授权的本地修改与只读调查；未授权的外部写入或不可逆操作，先准备可复核结果再请求批准。
- 验证按受影响行为和风险选择；已通过的检查只因新改动、失败或未解决疑点而扩大或重跑。

AGENTS.md、Skill、文档、PR 和 Issue（含标题、正文、评论、Review 总结与 finding）使用简体中文。代码标识符、命令、日志、schema 字段、API 名称及必要的第三方引文保留原文，解释和结论用中文。
