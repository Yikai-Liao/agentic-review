# 真实报告改写示例

以下取自本仓库已发布的评论，按各自所审版本改写；不是当前 PR 的问题清单，也不重新裁定原缺陷。来源与改写理由用于维护和验收，不放进实际发布的评论。保留原判断、等级和证据强度，运行元数据仍由发布器追加。

## 关闭失败：先补齐阻断重试的前提

来源：[PR #91 原评论](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421561733)，所审版本 `7b4324beff99b656725f51f310b1d814d59ef26c`。原文已被[后续修复说明](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421622784)关闭；这里保留当时的 finding。

原文用“封存文件”“封存路径”“失败占位”指同一个对象，并先解释 `try/catch/finally`。读者需要自己推出留下文件为什么阻断重试。改写先说明结果文件禁止覆盖，再串起失败过程：

```markdown
> [!WARNING]
> **P2：关闭结果文件失败后，同一轮审查无法再次提交**

提交工具会创建一个交给发布器的结果文件，并且不允许覆盖已有文件。如果内容已写入，但关闭文件时报错，工具会报告提交失败，却留下本次创建的结果文件。随后在同一轮审查中重试，会因为文件已存在（`EEXIST`）再次失败。

现有清理分支只处理写入失败。关闭文件的 `sealed.close()` 位于 `finally`，它抛出的异常不会进入该清理分支，因此结果文件没有删除。应让关闭失败也能清理本次调用创建的结果文件，以便故障解除后重新提交。

依据：所审版本的 [review-tools.ts:129–139](https://github.com/Qiyin-Tech/agentic-review/blob/7b4324beff99b656725f51f310b1d814d59ef26c/.github/pi-extensions/review-tools.ts#L129-L139)。

验收：模拟写入成功后关闭失败，确认工具返回失败并清理本次创建的结果文件；故障解除后可重新提交。正常提交时，工作稿中留存的副本与交给发布器的结果文件仍应一致。
```

原评论还提出“若故障留下的封存内容不完整，发布器也无法接受它”。本例的前提是写入成功；文件损坏需要另一组证据，未纳入已证明的主问题。没有把这一删减当作确认文件绝不会损坏。

复述要点：关闭失败留下结果文件；禁止覆盖已有文件使重试失败。缺少其中任何一环都不能算完整解释。

## 并发提交：区分两份结果的用途

来源：[PR #91 原评论](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421493287)，所审版本 `8ea95dfafc72b1ef1d6a924a63a0ef7ce4f67f9c`。静态审查、未执行测试的边界来自[同轮总评](https://github.com/Qiyin-Tech/agentic-review/pull/91#pullrequestreview-5709449405)。此问题后来已修复。

```markdown
> [!WARNING]
> **P2：并发提交不同结果时，留存副本可能与实际发布内容不一致**

提交工具会把审查结果保存两份：工作稿副本供维护者事后回查，另一份结果文件交给发布器。后者不允许覆盖，前者却在争取创建后者之前就会被写入。

如果两次调用并发提交不同内容，它们都可能通过“尚未提交”的检查。调用 A 写入副本并成功创建结果文件后，调用 B 仍可能覆盖副本，然后因结果文件已存在而提交失败。这样，发布器使用 A 的结论，维护者回查时看到的却是 B 的结论。

根因在所审版本的 [review-tools.ts:128–129](https://github.com/Qiyin-Tech/agentic-review/blob/8ea95dfafc72b1ef1d6a924a63a0ef7ce4f67f9c/.github/pi-extensions/review-tools.ts#L128-L129)。应确保只有获准提交的调用才能写入两份结果；验收并发提交不同内容时，两份结果逐字一致，失败调用不能覆盖成功调用留下的副本。
```

原文已经区分发布内容与工作稿副本，改写保留这一有效边界，并用 A/B 顺序交付具体反例。“工作稿副本”和“交给发布器的结果文件”不能合并成一个名字，否则会误解成公开内容被覆盖。

## 凭据测试：保留错误配置与当前生产的区别

来源：[PR #82 原评论](https://github.com/Qiyin-Tech/agentic-review/pull/82#discussion_r4420577606)。代码依据采用原评论正文明确绑定的版本 `d3a10572b7b7dd1760f1b628378431956243ca01`，不以评论 API 中后续更新的行号或 commit 替换所审证据。

```markdown
> [!CAUTION]
> **T1：通过配置变量传入写权限 token，凭据测试仍会接受**

中央审查 Agent 应始终只有 GitHub 读取权限，写入由它结束后的可信发布器完成。现有凭据测试却会接受这样的错误配置：仓库或组织变量保存了写权限 token，workflow 再通过 `EXTRA_TOKEN: ${{ vars.REVIEW_WRITE_TOKEN }}` 把它传入 Agent 环境。此时即使 `GH_TOKEN` 仍只读，Agent 也能用额外的 token 写入 GitHub。

原因是凭据来源检查 `assertSafeSource` 只拒绝 `secrets` 和无法追踪的 `steps` 引用，没有限制 `vars` 来源。因此上述配置不会触发断言，其余只读 token 和 job 权限检查也不能识别这条额外凭据路径。

测试会漏掉上述错误配置。依据是项目的只读权限约定，以及所审版本的 [review-runtime.test.ts:35–40](https://github.com/Qiyin-Tech/agentic-review/blob/d3a10572b7b7dd1760f1b628378431956243ca01/test/review-runtime.test.ts#L35-L40)。

应让测试识别并拒绝未经批准的变量凭据来源。验收时，上述写权限 token 配置应失败；模型名称、服务地址等非敏感配置，以及获准的只读 GitHub token 仍应通过。
```

必要前提是“额外 token 可以绕过只读 `GH_TOKEN`”，不是单纯出现 `vars` 就危险。明确保留错误配置需要变量实际存有写权限 token 的条件，以及“测试漏检”与“生产已泄漏”的区别。

## 修复后的回复：解释什么使原触发失效

来源：[PR #91 修复确认](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421622784)，复核版本 `8af24fae785d9b1ba5fbd001899e9beb4138c761`。

```markdown
已修复。关闭结果文件失败现在会进入清理流程，删除本次创建的结果文件；故障解除后，同一轮审查可以重新提交。

修复见 [8af24fa](https://github.com/Qiyin-Tech/agentic-review/commit/8af24fae785d9b1ba5fbd001899e9beb4138c761) 的 `review-tools.ts:131–140`：`sealed.close()` 已纳入外层错误清理。新增用例模拟关闭失败，检查文件清理、重试成功，以及工作稿副本与最终结果一致。
```

这里说明新增用例检查什么，既不把存在用例写成已经通过，也不追加默认审查方式的声明。

同轮[总评](https://github.com/Qiyin-Tech/agentic-review/pull/91#pullrequestreview-5709623627)可写为：

```markdown
## 自动代码审查 ✅

未发现需要处理的新问题。

这次补齐结果提交失败后的清理，并增加对应的重试回归用例。

- ✅ 已关闭：关闭结果文件失败后，现在会清理本次创建的文件，允许重新提交。[原问题](https://github.com/Qiyin-Tech/agentic-review/pull/91#discussion_r4421561733)
```

总评提供本轮结论与状态导航，完整原因留在对应回复；后续没有状态变化时不重复这条关闭记录。

## 无问题的总评：介绍改动即可

来源：[PR #92](https://github.com/Qiyin-Tech/agentic-review/pull/92)及其[总评](https://github.com/Qiyin-Tech/agentic-review/pull/92#pullrequestreview-5709770630)，所审版本 `d8844494b073dfcb94908200077e9a2d8233dd4a`。

```markdown
## 自动代码审查 ✅

未发现需要处理的新问题。

这次将审查启动时的五组 GitHub 信息从逐项读取改为同时读取，减少等待网络返回的时间。讨论刷新和关联 PR 的信息读取也复用这套实现。

作者对输入读取阶段的本机测速为：修改前 6.26～11.51 秒，修改后 1.36～1.96 秒。
```

介绍直接说明修改前后、涉及流程和收益。测量对象与来源在句内交代，不附加审查过程、未执行事项或预防性说明。
