# Repository guidance

## PR 和 Issue 语言

本仓库的所有 Pull Request 和 Issue 均使用简体中文，包括标题、正文、评论、Review 总结和 Review finding。代码标识符、命令、日志、schema 字段、API 名称和第三方原文按实际名称保留；引用外部材料时可以保留必要的原文，但解释和结论必须使用简体中文。

## Self-review trust boundary

This repository is privately maintained by a trusted maintainer. Self-review of an `agentic-review` pull request intentionally checks out the pull request's synthetic merge commit as the candidate Engine, installs its dependencies, and executes it to detect regressions in the Engine itself.

The candidate Engine is trusted code in this repository's maintenance model, not an untrusted-code sandbox. The self-review job may therefore expose the model runtime credential to the candidate process. This is an accepted boundary for trusted-maintainer regression protection; it must not be described as protection against a malicious contributor.

For ordinary downstream repositories, the Review Engine treats the target pull request as static input and does not execute target-repository code.
