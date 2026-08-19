# 当前状态与 TODO

## 当前阶段

中央 Review MVP 已部署，当前主线 `main@406d6cb` 已完成真实 GitHub Review 发布、required Check 和 Review thread 门禁的基础纵切面。当前版本仍需完成本文件的 P0 验收，完成前不推广到 Orchestra 全量仓库。

## 当前已实现

- Cloudflare Dispatcher Worker 验证 GitHub webhook 签名、过滤事件，并通过 Durable Object 原子去重 delivery。
- 中央 GitHub Actions Workflow 负责 Review Engine、Aggregator 和 Publisher；Dispatcher 不持有模型或 Lark 凭证。
- Review Engine 并发运行独立 Reviewer session，Reviewer 只能使用路径受限的 `review_read`、`review_grep`、`review_find`、`review_ls` 和一次 `submit_findings`。
- 默认启用 `production-semantics`（required、负责 overview）和 `test-quality`；另有 `performance`、`design-quality` prompt。
- Reviewer 配置只从目标 PR 的 base 快照读取，PR head 不能修改本次审查配置。
- Aggregator 只能完整分组 finding；可信代码确定性渲染 overview、evidence、trigger、base/head、constraint 和 impact，Publisher 在新 runner 上重新验证 schema、SHA 和 diff 位置后发布。
- 支持 RIGHT 新增/上下文行和 LEFT 删除行；同一次运行最多发布一条 GitHub Review。
- clean 审查也发布 `✅ Agentic Review` overview；有 finding 或 optional Agent 失败时发布 `⚠️`；required Agent、模型或 Publisher 失败时 required Check 失败并 fail closed。
- 当前 TypeScript 检查和 25 个单元测试通过：`pnpm check`、`pnpm test`。
- Benchmark corpus 含 5 个 defect 和 1 个 clean 样本，固定 SHA 已验证可获取；历史 baseline 见 [`benchmark-baseline-2026-08-14.md`](benchmark-baseline-2026-08-14.md)。

## 当前部署与仓库状态

- `main` 干净并与远端一致，PR #15 已合并，当前无开放 PR 或 Issue。
- GitHub Ruleset 要求 Agentic Review / `audit` Check 成功，并要求所有 Review thread resolved。
- Worker 已部署在 `https://agentic-review.daqiyin.com`，GET 返回预期的 405。
- 尚无正式 release tag，package version 仍为 `0.1.0`。
- `dev` 曾落后 main；后续开发必须以最新 main 为基线，不从过期分支继续分叉。

## P0：真实纵切面验收

### PR 1：文档修正 + self-review clean

本 PR 只修改本文件，并用于验证候选 Engine 的自审路径。必须确认：

- self-review 针对 `agentic-review` PR 检出 candidate Engine；
- candidate Engine 的 synthetic merge commit 恰好有两个 parent，且分别等于 PR base SHA 与 head SHA；
- candidate Engine 成功安装并执行；
- 最终只发布一条 Review，正文包含 `✅ Agentic Review`；
- clean 结果没有 inline finding；
- required Check 成功；
- 没有额外 Action 评论或重复 Review。

### PR 2：实验仓库 defect

创建新的、不是历史固定 head 的实验 PR，并人工确认：

- 同一 PR 同时包含一个 RIGHT 新增行缺陷和一个 LEFT 删除行缺陷；
- 两个 finding 的文件、side、行范围和上下文均正确；
- 只发布一条 Review，overview 为 `⚠️`；
- inline finding thread 阻止合并；
- 修复后创建新的 head 并重新运行，不再产生错误 finding，且不会因复用旧 head 的幂等逻辑而误判。

### P0 验收记录

- [ ] PR 1 clean self-review：candidate checkout、双 parent、安装和执行成功。
- [ ] PR 1 只产生一条 `✅ Agentic Review`，无 finding、无额外评论，Check 成功。
- [ ] PR 2 正确产生 `⚠️` overview、RIGHT/LEFT finding 和阻止合并的 thread。
- [ ] PR 2 修复后的新 head 不再产生错误 finding。
- [ ] required Agent、模型 API 或 Publisher 失败时不会发布 false-clean，且 Check failure 可观察。

验收完成前，不推广到 Orchestra 全量仓库。

## P1：验收后的稳定性与评估

- [ ] 用 PR #15 后的 Engine、prompt、schema、模型和 thinking level 重跑 sealed benchmark，记录新的 baseline。
- [ ] 为每个 Reviewer 记录耗时、token、重试和失败摘要。
- [ ] 对超大 diff 设置明确上限和可观察降级，不能静默截断后报告 clean。
- [ ] 增加最小 mock 模型和 mock GitHub API 集成测试。
- [ ] 将 `P0`–`P3` priority 与 `TEST`、`DESIGN`、`PERF` 工作流标签拆开。

## P1：Review thread 生命周期

- [ ] 为 finding 设计稳定且不可伪造的关联标识。
- [ ] 读取历史 Review comments 和 thread 状态，避免每个新 head 重复创建相同 finding。
- [ ] 只在 finding 状态变化时回复、resolve 或 reopen；每个 thread 每轮最多更新一次。
- [ ] 处理回复成功但状态变更失败等部分失败，保持 Check fail closed。

## P2：Reviewer 扩展

- [ ] 依据 diff 文件和代码特征确定性路由 performance Reviewer。
- [ ] 用独立正例、负例和 holdout 校准 performance Reviewer。
- [ ] 用真实后续变更成本样本校准 design-quality Reviewer。
- [ ] 只有在真阳性独立、噪声受控后才默认启用 design-quality。
- [ ] 在代表性实验仓库完成 replay 后，再讨论 Orchestra canary。

## 明确边界

- 目标仓库的测试、构建和 lint 不属于本项目职责。
- 普通下游仓库只作静态读取；self-review 会安装并执行 candidate Engine，因此 self-review 是可信维护者的回归保护，不是对恶意候选的独立安全边界。
- 当前尚未实现历史 thread 匹配、大 diff 分片、只读 GitHub/CI context、自动性能路由和 Lark 试运行。

## 建议顺序

```text
P0 两个真实 PR 与受控失败
→ 修复验收暴露的问题
→ 新 sealed benchmark baseline
→ priority schema 与最小集成测试
→ Review thread 生命周期
→ Reviewer 灰度扩展
→ 单仓库 canary
→ 再考虑 Orchestra 全量推广
```
