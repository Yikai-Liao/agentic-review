# Repository guidance

## Implementation goal

本仓库的目标是用最简单、最好维护、运行 overhead 最低的代码实现完整 Review 功能。每项改动都应优先减少执行路径、状态、抽象和依赖：只保留一条明确的生产路径和一个事实来源；不为历史调用方保留 legacy 兼容，不用吞错或降级掩盖失败，也不为假设中的未来需求增加扩展点。Workflow 只负责编排，非平凡的校验和业务逻辑应留在可测试的代码中。不得以简化为由移除安全边界、输入校验、数据保护或 fail-closed 行为。

## 维护者明确约束

- 修复必须解决真实根因。不得把失败改成 warning、skip、fallback 或成功状态来伪装问题已解决；若平台能力确实不支持，应明确说明并删除或重新定义该功能。
- 先确认实际权限边界再修改权限。Agent shell 中的 `GH_TOKEN` 必须保持只读；写操作只能由 Agent 结束后的可信 workflow 使用单独、最小权限的 token 执行，不能为了修复可信发布器而扩大 Agent token 权限。
- GitHub Actions 必须引用真实发布版本号（例如 `@v7.0.1`），不得固定 commit SHA，也不得用浮动 major tag 代替明确版本。
- 不增加没有实际故障证据或明确需求支撑的防御性分支、上限、兼容层和降级路径；先修共享根因，不能只处理表面症状。

## PR 和 Issue 语言

本仓库的所有 Pull Request 和 Issue 均使用简体中文，包括标题、正文、评论、Review 总结和 Review finding。代码标识符、命令、日志、schema 字段、API 名称和第三方原文按实际名称保留；引用外部材料时可以保留必要的原文，但解释和结论必须使用简体中文。

## Self-review trust boundary

This repository is privately maintained by a trusted maintainer. Self-review of an `agentic-review` pull request intentionally checks out the pull request's synthetic merge commit as the candidate Engine, installs its dependencies, and executes it to detect regressions in the Engine itself.

The candidate Engine is trusted code in this repository's maintenance model, not an untrusted-code sandbox. The self-review job may therefore expose the model runtime credential to the candidate process. This is an accepted boundary for trusted-maintainer regression protection; it must not be described as protection against a malicious contributor.

For ordinary downstream repositories, the Review Engine treats the target pull request as static input and does not execute target-repository code.
