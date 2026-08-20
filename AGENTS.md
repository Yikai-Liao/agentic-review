# Repository guidance

## Implementation goal

本仓库的目标是用最简单、最好维护、运行 overhead 最低的代码实现完整 Review 功能。每项改动都应优先减少执行路径、状态、抽象和依赖：只保留一条明确的生产路径和一个事实来源；不为历史调用方保留 legacy 兼容，不用吞错或降级掩盖失败，也不为假设中的未来需求增加扩展点。Workflow 只负责编排，非平凡的校验和业务逻辑应留在可测试的代码中。不得以简化为由移除安全边界、输入校验、数据保护或 fail-closed 行为。

## PR 和 Issue 语言

本仓库的所有 Pull Request 和 Issue 均使用简体中文，包括标题、正文、评论、Review 总结和 Review finding。代码标识符、命令、日志、schema 字段、API 名称和第三方原文按实际名称保留；引用外部材料时可以保留必要的原文，但解释和结论必须使用简体中文。

## Self-review trust boundary

This repository is privately maintained by a trusted maintainer. Self-review of an `agentic-review` pull request intentionally checks out the pull request's synthetic merge commit as the candidate Engine, installs its dependencies, and executes it to detect regressions in the Engine itself.

The candidate Engine is trusted code in this repository's maintenance model, not an untrusted-code sandbox. The self-review job may therefore expose the model runtime credential to the candidate process. This is an accepted boundary for trusted-maintainer regression protection; it must not be described as protection against a malicious contributor.

For ordinary downstream repositories, the Review Engine treats the target pull request as static input and does not execute target-repository code.
