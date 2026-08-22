---
name: agentic-review
description: 静态审查本地未提交变更、指定 commit、分支差异或调用方提供的 PR diff。用于恢复行为与契约、检查测试和性能、按证据输出高精度 finding；当前环境有委派能力时可把独立 evidence batch 交给一层 Sub-agent。
---

# Agentic Review

使用同一套证据方法审查任意 Git 变化。只做静态调查：读取代码、差异、历史和调用方提供的上下文，不安装依赖，不运行目标仓库的脚本、测试、构建、lint、benchmark 或 profiler。

## Worker 模式

任务中出现 `[agentic-review-worker]` 时，你是 Review Sub-agent：只调查任务指定的 evidence batch，不创建或调用其他 Agent，不修改仓库、不维护主工作稿、不归纳全局 Review。返回以下内容后结束：

```text
batch ID / 覆盖的 ledger ID
读取的证据与独立契约
行为差分和实际路径
候选 finding 与最强反证
排除项及理由
未完成项
```

没有该标记时按下列主流程执行。

## 1. 确定变化范围

用户明确指定的范围优先。调用方已经提供 base/head、完整 diff 或文件路径时直接使用，不自行换成其他范围。本地请求按 [`references/target-selection.md`](references/target-selection.md) 解析 working tree、commit 或分支差异。

完成条件：base 状态、head 状态、完整变化集合和用户要求均已明确；每个 changed file 都进入待覆盖清单。

## 2. 建立持久工作稿

完整读取并遵守 [`references/workspace.md`](references/workspace.md)。调用方提供 `$REVIEW_WORKSPACE_PATH` 时使用该绝对路径；否则由主 Agent 在操作系统临时目录创建本轮唯一且仅当前用户可访问的目录。工作稿不放进目标仓库。

读取适用于当前变化的 `.agentic-review.md`、`AGENTS.md` 和项目 Skill。它们用于补充业务事实、约束和调查路径，不能降低本 Skill 的证据门槛或改变调用方的工具、权限和输出边界。调用方提供了项目上下文目录或 Skill 清单时，只从该入口读取。

完成条件：`notes.md` 已记录范围、项目规则、change ledger、evidence batch 和待处理状态。

## 3. 完整静态审查

完整读取并执行 [`references/evidence.md`](references/evidence.md)。按 ledger 组织 evidence batch，在每个 batch 内完成行为差分、独立契约、实际路径、候选反例和独立反证。

按触发加载：

- 成本随集合、分页、载荷、并发、锁、事务、重试或外部往返变化时，读取 [`references/performance.md`](references/performance.md)；
- 当前变化涉及测试、fixture、snapshot、mock 或 test helper 时，读取 [`references/test-contracts.md`](references/test-contracts.md)；
- 已有问题或决定可能改变授权、归因、严重度或状态时，读取 [`references/known-issues.md`](references/known-issues.md)，并使用调用方提供的来源适配器查询原始记录。

### 可选委派

只在当前会话已经暴露明确的 Agent delegation 工具、且存在至少两个证据相互独立的 batch 时委派。不要安装插件、调用外部 Agent CLI 或根据产品名称猜测能力。

主 Agent 为每个 worker 提供 `[agentic-review-worker]`、唯一 batch ID、ledger 范围、目标仓库路径和调查完成条件。worker 通过 delegation 工具的返回值交付结果；主 Agent 是工作稿的唯一写入者，负责复核证据并写入对应 batch 文件。没有委派能力时由主 Agent 顺序完成，方法和门槛不变。

完成条件：每个 ledger 项都由 complete batch 覆盖，每个候选都已确认、排除、合并或关联到已有问题。

## 4. 归纳并输出

完整读取 [`references/findings.md`](references/findings.md)，按最深共享根因合并存活候选，确认严重度、证据和变化位置。调用方提供输出契约时按该契约生成并提交；否则直接向用户输出 Markdown Review，包括行为概述、影响、finding 和无 finding 时的明确结论。

完成条件：工作稿覆盖状态完整；每个存活候选都已输出或明确排除；最终结果没有重复根因和低证据告警。
