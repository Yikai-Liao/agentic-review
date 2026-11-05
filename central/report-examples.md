# 真实报告改写示例

以下取自本仓库已发布的评论，按各自所审版本改写；不是当前 PR 的问题清单，也不重新裁定原缺陷。来源与改写理由用于维护和验收，不放进实际发布的评论。保留原判断、等级和证据强度；标题、问题索引、Alert 和运行元数据由发布器生成，示例中的 finding 只展示 `label`、`title` 和 `body`。

## 关闭失败：先补齐阻断重试的前提

来源：[PR #91 原评论](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421561733)，所审版本 `7b4324beff99b656725f51f310b1d814d59ef26c`。原文已被[后续修复说明](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421622784)关闭；这里保留当时的 finding。

原文用“封存文件”“封存路径”“失败占位”指同一个对象，并先解释 `try/catch/finally`。读者需要自己推出留下文件为什么阻断重试。改写先说明结果文件禁止覆盖，再串起失败过程：

- `label`：`P2`
- `title`：关闭结果文件失败后，同一轮审查无法再次提交

```markdown
**什么情况下出错**：提交工具会创建一个交给发布器的结果文件，并且不允许覆盖已有文件。如果内容已写入、但关闭文件时报错，工具会报告提交失败，却留下本次创建的结果文件。随后在同一轮审查中重试，会因为文件已存在（`EEXIST`）再次失败。

**为什么**：现有清理分支只处理写入失败。关闭文件的 `sealed.close()` 位于 `finally`，它抛出的异常不会进入该清理分支，因此结果文件没有删除。见所审版本的 [review-tools.ts:129–139](https://github.com/Qiyin-Tech/agentic-review/blob/7b4324beff99b656725f51f310b1d814d59ef26c/.github/pi-extensions/review-tools.ts#L129-L139)。

**怎么改、怎么验证**：让 `.github/pi-extensions/review-tools.ts` 在关闭失败时也清理本次调用创建的结果文件。验收：模拟写入成功后关闭失败，工具返回失败并删除本次创建的结果文件，故障解除后可以重新提交；正常提交时，工作稿副本与交给发布器的结果文件仍然一致。
```

原评论还提出“若故障留下的封存内容不完整，发布器也无法接受它”。本例的前提是写入成功；文件损坏需要另一组证据，未纳入已证明的主问题。没有把这一删减当作确认文件绝不会损坏。

复述要点：关闭失败留下结果文件；禁止覆盖已有文件使重试失败。缺少其中任何一环都不能算完整解释。

## 并发提交：区分两份结果的用途

来源：[PR #91 原评论](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421493287)，所审版本 `8ea95dfafc72b1ef1d6a924a63a0ef7ce4f67f9c`。此问题后来已修复。

- `label`：`P2`
- `title`：并发提交不同结果时，留存副本可能与实际发布内容不一致

```markdown
**什么情况下出错**：两次提交并发传入不同的审查结果时，发布器可能使用调用 A 的结论，维护者事后回查的工作稿副本却是调用 B 的结论。

**为什么**：提交工具把结果保存两份：工作稿副本供维护者回查，结果文件交给发布器。结果文件不允许覆盖，工作稿副本却在争取创建结果文件之前就写入。两次调用都能通过“尚未提交”的检查；A 写入副本并成功创建结果文件后，B 仍可能覆盖副本，再因结果文件已存在而失败。见所审版本的 [review-tools.ts:128–129](https://github.com/Qiyin-Tech/agentic-review/blob/8ea95dfafc72b1ef1d6a924a63a0ef7ce4f67f9c/.github/pi-extensions/review-tools.ts#L128-L129)。

**怎么改、怎么验证**：让 `.github/pi-extensions/review-tools.ts` 只允许成功创建结果文件的调用写入工作稿副本。验收：并发提交不同内容时，两份结果逐字一致，失败的调用不能覆盖成功调用留下的副本。
```

原文已经区分发布内容与工作稿副本，改写保留这一有效边界，并用 A/B 顺序交付具体反例。“工作稿副本”和“交给发布器的结果文件”不能合并成一个名字，否则会误解成公开内容被覆盖。

## 凭据测试：保留错误配置与当前生产的区别

来源：[PR #82 原评论](https://github.com/Qiyin-Tech/agentic-review/pull/82#discussion_r4420577606)。代码依据采用原评论正文明确绑定的版本 `d3a10572b7b7dd1760f1b628378431956243ca01`，不以评论 API 中后续更新的行号或 commit 替换所审证据。

- `label`：`T1`
- `title`：通过配置变量传入写权限 token，凭据测试仍会接受

```markdown
**什么情况下出错**：中央审查 Agent 应始终只有 GitHub 读取权限，写入由它结束后的可信发布器完成。如果仓库或组织变量保存了写权限 token，workflow 再通过 `EXTRA_TOKEN: ${{ vars.REVIEW_WRITE_TOKEN }}` 把它传入 Agent 环境，凭据测试仍会通过。此时即使 `GH_TOKEN` 仍只读，Agent 也能用这条额外的 token 写入 GitHub。

**为什么**：凭据来源检查 `assertSafeSource` 只拒绝 `secrets` 和无法追踪的 `steps` 引用，没有限制 `vars` 来源；其余只读 token 和 job 权限检查也识别不了这条额外路径。见所审版本的 [review-runtime.test.ts:35–40](https://github.com/Qiyin-Tech/agentic-review/blob/d3a10572b7b7dd1760f1b628378431956243ca01/test/review-runtime.test.ts#L35-L40)。

**怎么改、怎么验证**：让 `test/review-runtime.test.ts` 识别并拒绝未经批准的变量凭据来源。验收：上述写权限 token 配置应使测试失败；模型名称、服务地址等非敏感配置，以及获准的只读 GitHub token 仍应通过。
```

必要前提是“额外 token 可以绕过只读 `GH_TOKEN`”，不是单纯出现 `vars` 就危险。明确保留错误配置需要变量实际存有写权限 token 的条件，以及“测试漏检”与“生产已泄漏”的区别。

## 多个分支或提交：先讲场景，再引入名称

来源：[PR #131 原评论](https://github.com/Qiyin-Tech/agentic-review/pull/131#discussion_r4467855797)，所审版本 `777abb4bf7cfe9bf86488b943014985f3d60b4e8`。该问题后来已修复。

原文开头就用 X、Y、S、S^1、H、F 描述提交关系，并连用 `S:F`、`merge-base(S^1,H)` 等写法，读者要先在脑中画出提交图才看得懂触发条件。改写先用具体对象讲场景，保留原判断、范围和证据：

- `label`：`P2`
- `title`：来源 PR 审查后改基，来源分支自带的未审文件被当作已审

```markdown
**什么情况下出错**：来源 PR 先以分支 B 为基准完成自动审查，随后改基到分支 A 并合入 A。来源分支因此带着 B 上有、A 上没有的几次提交；如果某个文件只被这几次提交修改过，来源 PR 的审查从未看过它，当前 PR 却把它记为“来源 PR 已审”，即使发布完整审计也不会再审查它。来源 PR 正常合入自己的目标分支时不受影响。

**为什么**：当前 PR 判断来源 PR 是否审过某个文件时，比较的是合入结果与来源 head、合入前基线与合入侧分叉点（[attribute-review-sources.ts:171](https://github.com/Qiyin-Tech/agentic-review/blob/777abb4bf7cfe9bf86488b943014985f3d60b4e8/scripts/attribute-review-sources.ts#L171)），上面那个文件两项都一致。但来源审查实际的起点是“审查时的基线与来源 head 的 `merge-base`”，[find-review-checkpoint.ts:101](https://github.com/Qiyin-Tech/agentic-review/blob/777abb4bf7cfe9bf86488b943014985f3d60b4e8/scripts/find-review-checkpoint.ts#L101) 读取来源审查记录时没有取出审查时的基线（Check 的 externalId 第 3 段已经记录）。该文件随后在文件进度中记为已完成（[review-coverage.ts:87](https://github.com/Qiyin-Tech/agentic-review/blob/777abb4bf7cfe9bf86488b943014985f3d60b4e8/scripts/review-coverage.ts#L87)）。

**怎么改、怎么验证**：在 `scripts/attribute-review-sources.ts` 中以来源审查实际使用的基线作为比较起点，要求文件属于该审查差异；无法确认时保持待审或叠加审查。验收：来源 PR 在 B 上审查后改基合入 A，并带有一个只改 B 历史文件的额外提交，该文件必须保持待审；来源 PR 自己修改的文件，以及正常合入其基线分支的来源 PR，仍记为来源已审。
```

分支用“来源 PR 的审查基线 B”“最终合入分支 A”等稳定名称，只保留 `merge-base` 一个必须的术语；提交图细节让位于读者要判断的因果：哪个文件、为什么被当作已审、后果是什么。

## 关闭原因：一行写清什么使原触发失效

来源：[PR #91 修复确认](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421622784)，复核版本 `8af24fae785d9b1ba5fbd001899e9beb4138c761`。

原回复先写“已修复”，再用两段解释修复和新增用例。状态词和提交号由发布器补上，`evidence` 只写原因：

```text
关闭文件失败现在也会删除本次创建的结果文件，同一轮可以重新提交（[8af24fa](https://github.com/Qiyin-Tech/agentic-review/commit/8af24fae785d9b1ba5fbd001899e9beb4138c761) 的 `review-tools.ts:131–140`），新增用例覆盖关闭失败后重试。
```

发布器把它写成原问题首行的 `**✅ 已关闭**（8af24fa）：关闭文件失败现在也会……`。总评只在“本轮关闭”中列出问题标题，原因不再重复。

## 续审总评：合并后的行为按最终状态写

来源：[PR #131](https://github.com/Qiyin-Tech/agentic-review/pull/131) 的[第二轮总评](https://github.com/Qiyin-Tech/agentic-review/pull/131#pullrequestreview-5768904193)，两轮审查的提交分别为 `777abb4` 和 `ebc7af6`。

原文重写了约 550 字的 PR 介绍，其中“只有……、且……的文件，才标为……”一长串判定条件与第一轮几乎相同；修复内容在开头句、介绍末段和问题清单中各说一遍。改写后的 `body`：

```markdown
上一轮指出的改基问题已修复，没有需要处理的问题。

**合并后的行为**

- 同步分支的 PR 不再逐个重审来源 PR 已经审过的文件：文件内容与来源 PR 审查时一致，就记为已审。
- 合入时叠加或冲突产生的文件仍要审查，并标出对应的来源 PR；无法确认来源 PR 审过的文件按普通方式审查。
- 判断来源失败时，本轮审查中止，不会把文件误记为已审。

**自上次审查**：来源 PR 是否审过某个文件，改为按来源审查时实际使用的基线判断。
```

判定条件属于代码和 finding；“合并后的行为”只写作者能核对的结果。修复细节写在那条问题的关闭原因里，本轮关闭清单由发布器生成。原总评没有记录本轮核对过的场景，改写不为它补写“核对了什么”。

## 无问题的总评：说清合并后会怎样

来源：[PR #92](https://github.com/Qiyin-Tech/agentic-review/pull/92)及其[总评](https://github.com/Qiyin-Tech/agentic-review/pull/92#pullrequestreview-5709770630)，所审版本 `d8844494b073dfcb94908200077e9a2d8233dd4a`。

```markdown
没有需要处理的问题。

**合并后的行为**：审查启动时同时读取五组 GitHub 信息，不再逐项等待；讨论刷新和关联 PR 的读取也复用这套实现。作者对输入读取阶段的本机测速为：修改前 6.26～11.51 秒，修改后 1.36～1.96 秒。
```

单一主题用一段。测量对象与来源在句内交代，不附加审查过程、未执行事项或预防性说明。原总评同样没有记录核对场景。

## 多主题：按主题分项

来源：[PR #99 总评](https://github.com/Qiyin-Tech/agentic-review/pull/99#pullrequestreview-5712050880)，所审版本 `45b05da355fdbaae8a4013483ae3bd8a93a84710`。

原文把归档、输入准备和讨论刷新三个独立主题放在同一段。改写用列表显露各项变化：

```markdown
没有需要处理的问题。

**合并后的行为**

- **归档**：成功发布的报告并入完成工作区一起上传，不再单独归档；发布前的可恢复草稿和失败诊断路径保持不变。
- **输入准备**：相同比较区间的 patch 只生成一次。
- **讨论刷新**：返回发生变化的讨论的根评论、完整回复和当前状态，不再返回零散的变化记录。
```

每项只说明一个主题。只有一个主题时保留短段，不为增加排版层次拆成列表。
