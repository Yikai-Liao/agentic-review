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

也可以在 GitHub Actions 手动运行 `Agentic Review Benchmark` workflow，并选择 Reviewer thinking level；成功后下载 `agentic-review-benchmark-<run-id>` artifact。

Runner 顺序检出固定 base/head，只运行 `production-semantics` Reviewer，再用无仓库工具的独立 Judge 判断所有 expectation/finding 候选对；最终由程序做一对一最大匹配。任一检出、模型、schema、定位或 Judge 失败都会令进程失败，并且不会写出 clean 报告。结果默认写到 `.benchmark/report.json`，包含命中/漏掉的 expectation、未匹配 finding、clean noise、耗时、token、模型和 thinking level。

命中率只相对于清单中已选 expectation。清单不是完整缺陷集，因此缺陷样本上的 unmatched finding 单独列出并等待人工裁决，不能直接计为 FP；只有 clean 样本上的 finding 才计为误报。
