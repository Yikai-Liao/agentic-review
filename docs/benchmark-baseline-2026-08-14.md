# Benchmark Baseline：2026-08-14

## 运行

- Workflow：[Agentic Review Benchmark #31827587220](https://github.com/Qiyin-Tech/agentic-review/actions/runs/31827587220)
- Engine：`10690774ef103a02a35850ed28dfe28776572e16`
- 模型：`gpt-5.6-luna-2`
- Reviewer thinking：`high`
- Judge thinking：`low`
- 样本：5 个 AACR-Bench TypeScript defect + 1 个 SWRench clean
- 耗时：787,220 ms（约 13.1 分钟）
- token：4,297,509 total，其中 3,876,684 cache read、31,605 reasoning

Reviewer 只读取每个外部样本的 head checkout 与生成的 base/diff context；未读取 expectation，未调用 Shell，也未向原 PR 发布评论。

## Manifest 结果

| 指标 | 结果 |
| --- | ---: |
| 命中的已知 expectation | 4 / 5 |
| 漏掉的已知 expectation | 1 / 5 |
| Manifest recall | 80% |
| Defect 样本中的 unmatched finding | 4 |
| Clean 样本 finding | 0 |
| Clean noise rate | 0%（1 个样本） |

唯一漏掉的是 Gemini CLI #9177 的 empty-string stdin 未关闭 EOF 问题。固定的 1 个 clean 样本上没有 finding。

## Unmatched finding 裁决

Manifest 不是完整缺陷集，因此 unmatched finding 不直接计为 FP。对精确 base/head 做独立代码路径复核后，4 个均被判为可归因于 head 的额外问题：

1. n8n #15057：archive 授权未命中后仍把完整 ID 集移动到 root，P2；模型建议的 P1 偏高。
2. n8n #13323：`docker/build-push-action` 的 `build-args` 不执行 `$(date ...)` shell substitution，P2。
3. Gemini CLI #9177：集成测试使用真实用户 extension store，且没有失败路径恢复，P2。
4. Gemini CLI #9177：无条件 `rmSync` 绕过 `KEEP_OUTPUT`，P3；模型建议的 P2 偏高。

这次运行因此得到 8 个经代码路径复核的有效 finding（4 个 manifest match + 4 个额外 finding），以及 1 个已知漏检。这里的“有效”来自独立 Agent 复核，不等于两个人工确认。

## 暴露并修复的 Evaluator 问题

首次运行 [#31826109968](https://github.com/Qiyin-Tech/agentic-review/actions/runs/31826109968) 暴露：Reviewer 可能把 finding 放在 service 根因行，而 manifest 评论位于 controller 调用行。只比较同文件候选会错误记成漏检。

PR #5 已改为让 Judge 判断所有 expectation/finding 候选对，再由程序执行确定性一对一最大匹配；同时删除了把 defect 样本 unmatched finding 命名为 FP 的误导字段。上述 baseline 使用修复后的 Engine。

## 结论边界

- 这证明了 sealed external PR replay、Reviewer 隔离、Judge、计分和 artifact 路径能真实运行。
- 不能据此宣称 80% 通用召回率或 0% 通用误报率：样本只有 6 个，clean 只有 1 个。
- 严重度仍需校准：4 个额外 finding 中有 2 个被独立复核降级。
- 尚未验证真实 GitHub PR 上的单次 Review 发布、空 Review 抑制和 thread 生命周期。
- 后续版本比较必须固定 corpus、Engine、模型和 thinking，并至少重复运行以观察模型波动。
