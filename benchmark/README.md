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
