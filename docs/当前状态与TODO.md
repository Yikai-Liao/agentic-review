# 当前状态与 TODO

## 当前阶段

Review Engine 的最小纵切面已经完成并推送到 `main`。它证明了核心执行路径可以成立，但尚未在真实模型和真实 GitHub PR 上完成端到端验证，因此当前不能视为可迁移到 Orchestra 的生产版本。

## 已完成

- 一个 reusable GitHub Actions job，只安装一次 pnpm、Node.js 和 Pi SDK。
- 分别检出被审仓库 PR head 与固定 commit 的 Review Engine。
- 准备 base 完整快照、`base...head` diff、变更文件列表和运行元数据。
- 仓库专用 Review 规则只从 base 快照读取，PR head 不能削弱本次审查规则。
- 使用共享 `ModelRuntime` 并发运行独立 Reviewer session。
- 已提供生产语义、测试质量、性能和设计质量四类 Reviewer prompt；当前默认只启用生产语义和测试质量。
- Reviewer 只有只读代码工具和 `submit_findings`，不能发布 GitHub 评论。
- finding 使用 TypeBox schema 校验，包含触发条件、base/head 行为、违反约束、影响和建议等级。
- 聚合 Agent 直接信任 Reviewer 结果，看不到仓库、diff、base 或 policy，不做二次证据校验；只合并明显重复项、排版并一次性发布。
- GitHub 工具限制每次运行最多创建一个 `COMMENT` Review，并验证 inline comment 的文件和 RIGHT-side diff 行。
- 全部说明文档和 prompt 使用中文，代码标识符、schema 字段和第三方 API 名称保留英文。
- 已建立 evaluator-only corpus：5 个经人工筛选的 AACR-Bench TypeScript 缺陷样本和 1 个 SWRench clean 样本；Reviewer context 不包含 expectation。
- 已实现 fail-closed Benchmark runner：隔离回放仓库、独立语义 Judge、manifest TP/FP/FN、precision/recall、耗时、token、模型和 thinking level 报告。
- Reviewer 文件工具限制在目标仓库与生成的 Review context 内，finding 必须通过共享 RIGHT-side diff 定位校验。
- `pnpm install --frozen-lockfile`、`pnpm check` 和 8 个单元测试通过。

## 当前明确边界

- 尚未调用真实模型。
- 尚未向真实实验 PR 发布 Review。
- 尚未处理已有 Review thread 的读取、匹配、回复、关闭和重新打开。
- 尚未实现大 diff 的上下文预算、裁剪或分片。
- 尚未实现 Benchmark 版本对比。
- 性能 Reviewer 尚无自动路由；设计质量 Reviewer 尚未默认启用。
- 当前只有 schema、base policy、diff 行、sandbox、benchmark manifest 与计分逻辑的单元测试，没有模型和 GitHub API 集成测试。
- 当前生产语义 Reviewer 失败会中止；其他 Reviewer 的失败会写入 `failures.json`，最终失败策略仍需通过实验确定。

## TODO

### P0：跑通真实纵切面

- [ ] 在一个实验仓库添加 caller workflow，配置 `AGENTIC_REVIEW_TOKEN`、`REVIEW_AGENT_API_KEY`、`REVIEW_AGENT_MODEL` 和 `REVIEW_AGENT_BASE_URL`。
- [ ] 创建一个无问题 PR，确认 Reviewer 可以返回零 finding，且不会发布空 Review。
- [ ] 创建一个含明确语义缺陷的 PR，确认只发布一个 Review，路径和行号正确。
- [ ] 人工核对 Reviewer 输出、聚合后输出和 GitHub 最终内容，记录耗时、token、费用和噪声。
- [ ] 验证 Reviewer 超时、结构化提交缺失、模型 API 失败和 GitHub API 失败不会被误判为 clean。

验收：同一实验仓库至少完成一次 clean PR 和一次 defect PR；没有额外 Action 评论；失败状态可观察且不会产生错误 clean 结论。

### P1：建立可回归的评估闭环

- [x] 从固定 commit 的 AACR-Bench 选取 5 个 TypeScript Defect/Security 样本，并逐个验证 base/head SHA 可获取。
- [x] 定义 evaluator-only expectation manifest，避免 Reviewer prompt 泄漏答案。
- [x] 实现最小 benchmark runner，记录 TP、FP、FN、precision、recall、耗时、token、模型和 reasoning level。
- [ ] 加入 clean/noise 样本以及公司内部历史缺陷和 seeded PR。
- [ ] 按 `docs/规则演化.md` 执行同一 judge 成对比较、退化回滚和两个人工确认门。

验收：任何 prompt、模型、thinking level 或聚合规则变更都能用同一 sealed corpus 比较前后结果。

### P1：完成 Review 生命周期

- [ ] 从 GitHub 读取现有 Review comments 和 thread 状态。
- [ ] 为 finding 设计稳定、不可伪造的关联标识，替代脆弱的自然语言前缀匹配。
- [ ] 只在状态变化时回复已有 thread；每个 thread 每轮最多更新一次。
- [ ] 处理 reopen/resolve 的部分失败，避免先回复成功、后状态修改失败造成不一致。

验收：重复运行不会重复发同一 finding；修复、重新引入和扩大问题能够更新原 thread。

### P2：扩展 Reviewer

- [ ] 根据 diff 文件和代码特征确定性路由性能 Reviewer。
- [ ] 使用独立正例、负例和 holdout 对性能规则做对抗演化。
- [ ] 使用真实后续变更成本样本校准设计质量 Reviewer。
- [ ] 只有在设计质量 Reviewer 证明具有独立真阳性且噪声受控后才默认启用。

### P2：运行稳定性

- [ ] 增加每个 Reviewer 的耗时、token、重试和失败摘要。
- [ ] 为超大 diff 设置明确上限和可观察的降级结果，不能静默截断后报告 clean。
- [ ] 增加 mock 模型和 mock GitHub API 的最小集成测试。
- [ ] 固定 Engine、prompt、schema、模型和 reasoning level 版本并写入运行结果。
- [ ] 在三个实验仓库完成代表性 PR replay 后，再讨论迁移 Orchestra。

## 建议执行顺序

1. 先完成 P0 的两个真实 PR，不继续扩展架构。
2. 修掉纵切面暴露的运行问题。
3. 建立最小 benchmark runner 和 sealed corpus。
4. 再实现 thread 生命周期。
5. 最后校准并逐步开启性能、设计质量 Reviewer。
