# 可选委派协议

仅在调用方允许、环境已有 delegation 工具且存在至少两个独立 evidence batch 时使用。不要安装插件、调用外部 Agent CLI 或按产品名称猜测能力。

主 Agent 提供 `[agentic-review-worker]`、唯一 batch ID、ledger 范围、目标仓库路径、必要规则与证据、完成条件；结果写入遵循 [workspace.md](workspace.md) 的单写者边界。

带 `[agentic-review-worker]` 标记的任务只调查指定 batch，不创建其他 Agent，不修改仓库或主工作稿，不归纳全局 Review。返回以下内容后结束：

```text
batch ID / 覆盖的 ledger ID
读取的证据与独立契约
预期结果、行为差分、实际消费路径和保护检查
候选 finding 与最强反证
排除项及理由
未完成项
```
