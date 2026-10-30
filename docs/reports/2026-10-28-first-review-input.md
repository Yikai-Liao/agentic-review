# 首审输入减负：保留讨论证据，裁剪 API 元数据

## 改动与边界

`readDiscussion` 原来将 GitHub REST 返回的评论对象原样送入模型。每条评论重复包含用户头像、关注列表地址、API 导航链接等字段，关联 PR 较多时会明显增加上下文。

本次在该公共读取函数中裁剪 API 导航字段，将作者保留为 ID、登录名、类型和主页，将应用保留为 ID、slug 和名称。其他顶层字段继续保留，包括完整正文、diff hunk、时间、版本、行号、回复关系、Review 状态、来源信息和反应计数。GraphQL thread 状态不变。

当前 PR 初始输入、关联 PR 读取和最终讨论刷新均使用该表示。刷新指纹基于裁剪后的证据，头像地址变化不再被当成新的讨论内容；正文编辑、定位、版本、Review 状态及 thread 变化仍被检出。分页、查询失败处理和固定启动基线不变。

模型和 `xhigh` 保持不变；没有修改审查职责、Prompt 或证据门槛，没有运行目标仓库代码。

## 冻结真实输入的确定性回放

选择后端 #844 首审实际查询过的关联 PR #837、#840、#841、#842、#843。重新读取时间为 2026-10-28 05:37:29–05:37:42 UTC；它们是本次读取时的完整讨论快照，不冒充首审当时的历史快照。

基线代码为 `2a0261a39a71c1d414b9931845779b16527ae4b7`。新旧代码使用相同、已冻结的 API 响应，均执行真实 `readDiscussion`。比较每条记录和 thread，检查除明确裁剪的导航及作者资料字段外，其余字段值与记录顺序完全一致。未调用模型，不将此测试描述为 Darwin 盲评或端到端速度实验。

字符数按相同的 `JSON.stringify(discussion, null, 2)` 输出计算 Unicode 字符，包含字段名和空白，不等同于 token。

| 关联 PR | 评论及 Review 数量 | 修改前字符 | 修改后字符 | 减少 |
|---|---:|---:|---:|---:|
| [#837](https://github.com/Qiyin-Tech/orchestra-backend/pull/837) | 1 | 3,356 | 1,727 | 48.5% |
| [#840](https://github.com/Qiyin-Tech/orchestra-backend/pull/840) | 26 | 110,089 | 66,615 | 39.5% |
| [#841](https://github.com/Qiyin-Tech/orchestra-backend/pull/841) | 8 | 28,118 | 14,743 | 47.6% |
| [#842](https://github.com/Qiyin-Tech/orchestra-backend/pull/842) | 1 | 2,922 | 1,293 | 55.7% |
| [#843](https://github.com/Qiyin-Tech/orchestra-backend/pull/843) | 1 | 4,098 | 2,469 | 39.8% |
| 合计 | 37 | 148,583 | 86,847 | **41.5%** |

完整快照、基线/候选代码、逐文件 SHA-256 和回放脚本保存在 Git 忽略的 `evals/experiments/2026-10-28-first-review-input/`。持有本地材料时可运行：

```sh
node evals/experiments/2026-10-28-first-review-input/replay.ts
```

新克隆不包含上述原始私有讨论。仓库保留合成回归测试，验证证据保留、作者为空、元数据变化不制造增量，以及正文、版本、定位和状态变化仍可识别。

## 验证与未解决问题

以下检查通过：

```sh
pnpm exec tsx --test test/review-discussion.test.ts test/review-input.test.ts test/related-pr.test.ts
pnpm check
git diff --check
```

共 10 项测试通过。真实回放中，37 条讨论记录和 4 个 thread 的相关证据全部保留。

这项结果只证明讨论输入减少；它不代表完整上下文减少 41.5%，也不证明首次审查时间减少相同比例。尚未测量同一 PR、同一模型与推理档位下的端到端时间变化。

样本还包含 20,676 字符完全重复的 `diff_hunk`，集中在同一问题的多条回复中。当前保留这些片段；后续去重必须让每条回复仍能恢复自己的版本、位置和完整上下文，不能直接删去或依赖模型猜测。跨仓取证和测试审查的必要性也不能由本次输入体积结果裁决。
