# Benchmark corpus

`corpus.json` 是 evaluator-only 清单，不是 Reviewer context。Reviewer 只能看到目标仓库的 base、head 和 diff；expectation 仅供运行结束后的匹配与人工裁决。

当前最小 corpus 包含：

- AACR-Bench 固定版本中的 5 个 TypeScript 缺陷样本；
- SWRench 固定版本中的 1 个 clean 样本。

仓库不保存完整外部数据集。每个来源记录固定 commit、文件 SHA-256 和许可证；每个样本记录原 PR、base/head 与人工筛选后的 expectation。加入样本前必须确认：

1. base/head commit 仍可获取；
2. base 正常、head 引入问题；
3. expectation 位于当前 RIGHT-side diff；
4. expectation 没有泄漏给 Reviewer。

c-CRAB 可作为内部临时评测源，但因没有明确许可证，不复制其原始数据或评论到本仓库，只按固定来源临时拉取。

## 运行

```bash
REVIEW_AGENT_MODEL=... REVIEW_AGENT_API_KEY=... pnpm benchmark:run
```

Runner 顺序检出固定 base/head，只运行 `production-semantics` Reviewer，再用无仓库工具的独立 Judge 做同文件语义匹配。任一检出、模型、schema、定位或 Judge 失败都会令进程失败，并且不会写出 clean 报告。结果默认写到 `.benchmark/report.json`，包含 TP、FP、FN、precision、recall、耗时、token、模型和 thinking level。

指标只相对于清单中已选 expectation；缺陷样本上的 unmatched finding 仍需人工裁决，不能直接当作真实误报。clean 样本上的 finding 可直接计为 FP。
