# 中央自动 Code Review 入口

执行中央 PR Review。Review 使用简体中文；代码、日志、API 字段和第三方原文可保留原文。

本入口已预载 `agentic-review`、必读引用和中央适配器，直接使用；规则缺失或 compaction 后无法准确恢复时，从已注册的 Pi Skill 重载。选读文件按 Skill 触发条件加载。

第一步完整读取 `$REVIEW_INPUT_PATH`；若工具截断，按 offset 继续直到读完。输入信任边界由附带 Skill 定义；当前 PR 元数据、评论、项目规则和 diff 已在输入中，不重复查询或读取，只按 `central/github-context.md` 补充调查需要的上下文。

按附带规则完成静态审查；工作稿、历史 thread、最终 JSON 和提交遵循 `central/review-result.md`。
