# 中央 Review 结果

本文件只定义中央 Action 的持久化、GitHub thread 更新和可信发布格式。finding 门槛、严重度和根因归纳来自可信 `agentic-review` Skill。

## 1. 中央工作稿

workflow 已把 `$REVIEW_WORKSPACE_PATH` 设置为隔离目录。按通用 `workspace.md` 持续维护 `notes.md` 和 `batches/`；`write`、`edit` 只能修改该目录。`bash` 只用于静态调查、创建工作区目录及使用 Runner 已安装的 `jq` 检查 JSON，不能修改 target/base checkout。

工作稿会作为受权限保护、限期保留的 Actions artifact。不要记录 token、环境变量值或与审查无关的敏感信息。

## 2. 历史 thread 状态

中央 Review 使用简体中文；代码、日志、API 字段和第三方原文可保留原文。

把存活候选与当前 PR 已有 inline thread 和最新回复比较，一个根因只保留一条：

- 未变化且未解决：不生成 thread update，正文列为 `⏳ 仍未解决`；
- 已修复，或被更强代码/API/测试契约证据推翻：`suggest_resolve`；
- 影响、成本或严重度扩大：`severity_increased`；
- 已解决问题重新出现：`reintroduced`。

正文有历史 thread 时使用 `⏳ 仍未解决`、`⚠️ 风险升级`、`🔁 问题重现` 或 `✅ 建议关闭`；状态变化的详细证据放在线程更新中。T2→T1、P2→P1/P0，或性能从有界路径变成无界/常见路径，属于风险升级。测试问题升级为已证明的生产问题时更新原 thread，不另开同根评论。

使用原 inline thread 的 root comment ID；每个 thread 每轮最多更新一次，且最新 `Pi thread 状态更新` 相同时不重复。可信 publisher 负责回复和 resolve/reopen。

## 3. 最终归纳

完成全量审查后，先读取 `notes.md` 中的覆盖状态、complete batch 的结论和 surviving finding 草稿。确认每个 ledger/census 关联都已由 complete batch 覆盖；不要为最终归纳重新执行已经完成且没有关联候选的 batch。只有 finding 可能共享根因、cluster key 冲突、覆盖状态不一致、会话发生过 compact 或无法准确确认约束时，才重新读取相关 batch 的完整证明、代码位置、历史 thread、known issue 或对应 Skill。

然后按根因重新聚类：合并重复项，将表层症状提升到已证明的最深共享根因，删除被反证的候选，并检查每条 finding 的严重度、证据、RIGHT-side diff 位置和独立可读性。最终覆盖状态可用 `edit` 更新到 `notes.md`；只有完成这次最终归纳后才能生成 JSON。

## 4. 最终 JSON

完成全部 batch 和最终根因归纳后，将文件写到 `$REVIEW_WORKSPACE_PATH/review-result.json`。文件必须是 UTF-8 JSON 对象，且只包含以下三个字段：

```json
{
  "body": "完整的 Markdown Review 正文",
  "comments": [
    {
      "path": "仓库相对路径",
      "line": 42,
      "start_line": null,
      "body": "完整 inline finding Markdown"
    }
  ],
  "thread_updates": [
    {
      "root_comment_id": 123456,
      "status": "suggest_resolve",
      "evidence": "状态变化的完整证据"
    }
  ]
}
```

约束：

- `body` 是自由 Markdown，不是固定统计表。它应清楚介绍 PR 改变的行为、实现路径、影响、审查结论、新 finding 导航、历史 thread 状态和必要的 known issue 链接；不要添加 Action footer；
- 有新 finding 或人工确认时标题使用 `## 自动代码审查 ⬆️`；没有新 finding 但仍有未解决历史问题时使用 `## 自动代码审查 ❌`；其余使用 `## 自动代码审查 ✅`；按实际内容使用“生产行为与安全”“性能”“测试契约”“需人工确认”和“已有问题”分组，只列标题和 thread 链接；
- `comments` 只保留最终归纳后的新 finding，每项恰好包含 `path`、`line`、`start_line`、`body`；路径必须是仓库相对路径，单行使用 `start_line: null`，多行起始行不得大于 `line`；
- `thread_updates` 只保留当前 PR 中状态实际变化的历史 inline thread，每项恰好包含 `root_comment_id`、`status`、`evidence`；`status` 只能是 `suggest_resolve`、`severity_increased` 或 `reintroduced`；
- 没有新 finding 或 thread update 时使用空数组，仍提供完整 `body`；
- 文件不得超过 1 MB，不得包含额外字段、注释、Markdown fence 或 trailing text。

中央 inline finding 严格使用以下结构，各段之间空一行：

```markdown
> [!CAUTION]
> **P1：简短标题**

**📌 问题与触发**

说明应保持的结果、现实入口和 base/head 差异；性能写成本变化，测试写对应分支的判定证明。

**💥 影响**

说明谁受到什么可观察影响及范围。

**🛠️ 依据与处理**

给出代码或独立契约证据，以及要恢复的约束、修复方向或待批准决定。
```

Alert 与标题：P0/P1 使用 `> [!CAUTION]`，P2/T2 使用 `> [!WARNING]`，T1 使用 `> [!CAUTION]`，人工确认使用 `> [!IMPORTANT]`；不添加“等级：”前缀。单行足以表达根因时使用 `start_line: null`，只有声明、条件、调用或错误处理共同构成根因时才覆盖连续范围。

测试 finding 必须给出 violating、allowed-change 或 deletion/witness 证明；性能 finding 必须给出规模、成本函数和数量级或复杂度证据。

重新读取 JSON，确认 complete batch 中每个存活 finding 都已合并、发布或明确排除，再执行：

```bash
jq -e . "$REVIEW_WORKSPACE_PATH/review-result.json"
```

## 5. 唯一提交

最后恰好调用一次：

```text
submit_review({"path":"<REVIEW_WORKSPACE_PATH>/review-result.json"})
```

`submit_review` 只封存该文件；可信 publisher 会重新验证 schema，把 `body` 与全部 inline comments 发布到本轮审查的 head，处理历史 thread，并追加运行元数据。不要通过其他工具发布，也不要在提交后继续修改结果文件。
