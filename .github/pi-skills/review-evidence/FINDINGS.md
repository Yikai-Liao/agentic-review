# Finding 输出

只有通过 `SKILL.md` 反证和归因的候选才能成为 finding；没有存活候选时仍按本文件生成 Review 正文并完成自检。

## 输出门槛

只发布：

1. 具有可观察生产后果的 P0/P1/P2 行为或性能问题；
2. 达到 `TEST-CONTRACTS.md` 门槛的 T1/T2 测试契约问题；
3. 达到 `SKILL.md` 门槛的 `[需人工确认]` 高风险契约变更。

每项都要形成绑定 diff 行的 Review conversation。没有合格候选时输出零 finding。

### 生产严重度

- **P0 — 阻断发布**：现实可达的系统性或不可逆后果，例如大范围不可用、跨租户或未授权访问、凭证泄露、不可恢复的数据破坏、资源耗尽或依赖雪崩；
- **P1 — 高优先级**：常见路径或较大范围用户可达，并破坏关键业务、安全、数据正确性、性能或可靠性，且没有可靠规避；
- **P2 — 一般缺陷**：已证明的行为或性能错误，但触发条件或影响较窄，或存在可靠临时规避。

严重度依据可观察影响、范围和紧迫性，而不是代码形状、缺少测试或复杂度符号。不输出 P3/T3。`[需人工确认]` 不是较低严重度，也不是弱证据的兜底。

## Review 正文

先用不依赖代码上下文的语言说明业务流程、关键行为路径、相关性能规模和证据边界，再给 finding 导航。

标题按顺序选择：

1. 有新 P/T finding 或 `[需人工确认]`：`## 自动代码审查 ⬆️`；
2. 没有新 finding，但仍有未解决历史问题：`## 自动代码审查 ❌`；
3. 两者都没有：`## 自动代码审查 ✅`。

按实际内容使用 `### 生产行为与安全`、`### 性能`、`### 测试契约`、`### 需人工确认` 分组，只列标题和 thread 链接。

当前 PR 有历史 thread 时增加 `### 历史 thread 状态`，使用 `⏳ 仍未解决：`、`⚠️ 风险升级：`、`🔁 问题重现：`、`✅ 建议关闭：`。状态变化的详细证据放在线程更新中。

## Inline comment

每条 finding 必须独立可读，并包含：

1. **问题与触发**：应保持的结果、现实入口，以及 base/head 在根因行上的差异；
2. **影响**：生产或测试信号的可观察后果和范围；
3. **依据与处理**：代码或独立契约证据，以及要恢复的约束、修复方向或待批准决定；
4. 当前 diff 中最接近根因的最小可操作 RIGHT-side 行范围。

严格使用以下结构，各段之间空一行：

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

Alert 与标题：

- P0/P1：`> [!CAUTION]`，`> **P0：标题**` / `> **P1：标题**`；
- P2：`> [!WARNING]`，`> **P2：标题**`；
- T1：`> [!CAUTION]`，`> **T1：标题**`；
- T2：`> [!WARNING]`，`> **T2：标题**`；
- 人工确认：`> [!IMPORTANT]`，`> **需人工确认：标题**`。

不添加“等级：”前缀。每段使用完整句子，不堆叠标识符。具体表达式构成根因时，在 `🛠️ 依据与处理` 中放一个带语言标识的最小代码块；不要复制 inline diff 已清楚展示的内容。

性能 finding 必须静态量化，例如：

```text
base: 1 次批量请求处理最多 N 个对象
head: 1 + N 次远程请求；N=100 时至少 101 次往返
```

测试 finding 必须给出对应分支的证明：T1 使用 violating probe，T2 change detector 使用 allowed-change probe，T2 redundancy 使用 deletion test、base/sibling 覆盖和缺失 unique witness 的证明。例如：

```text
错误变化：默认值改错，expected 与实现共用常量；测试仍会通过。
允许变化：新增合法命令 c，契约仍只要求 a、b 可用；完整列表 equality 会失败。
删除测试：base 已覆盖相同路径、partition 和 oracle；删除后没有现实契约错误会漏过相关 suite。
```

单行足以表达根因时只选单行；只有声明、条件、调用或错误处理共同构成根因时才覆盖连续范围。单行使用 `start_line: null` 和 `start_side: null`。

## 当前 PR 去重

把每个存活候选与当前 PR 的已有评论和最新 thread 回复比较；一个根因只保留一条。

- 未变化且未解决：不生成 thread update，正文列为 `⏳ 仍未解决`；
- 已修复，或被更强代码/API/测试契约证据推翻：`suggest_resolve`；
- 影响、成本或严重度扩大：`severity_increased`；
- 已解决问题重新出现：`reintroduced`。

T2→T1、P2→P1/P0，或性能从有界路径变成无界/常见路径，属于风险升级。测试问题升级为已证明的生产问题时更新原 thread，不另开同根评论。

使用原 inline thread 的 root comment ID；每个 thread 每轮最多更新一次，且最新 `Pi thread 状态更新` 相同时不重复。可信 publisher 负责回复和 resolve/reopen。

## 最终自检

交给 `submit-review` 前确认：

- `review-workspace` 的 change ledger 已满足完成条件；
- 每条 finding 都有 base/head 差分、现实入口、完整路径和可观察边界；
- T finding 有对应分支的证明：T1 的 violating probe、T2 change detector 的 allowed-change probe，或 T2 redundancy 的 deletion test、base/sibling 覆盖和缺失 unique witness；
- 性能 finding 有规模、成本函数和数量级或复杂度证据；
- 上游保护、合法例外、base 行为和已有 thread 已检查；
- 同一根因没有同时输出 P、T 和人工确认；
- 每条评论绑定最小根因范围，并能独立阅读；
- 没有为显示“审查过”而保留低信号 finding。
