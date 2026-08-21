# Test contract review

只审查当前 diff 改动的测试、fixture、snapshot、mock、test helper，以及生产变更使既有测试的错误判定重新可达的情况。单纯缺少测试、覆盖率或更多用例不属于本专项。

测试审查有三种彼此独立的失败模式：

- **T1 false confidence**：测试接受了它声称拒绝的错误；
- **T2 change detector**：测试拒绝契约允许的变化；
- **T2 zero-marginal signal**：测试本身可以正确，但相对现有 suite 没有新增故障检测能力，只增加重复失败信号和维护点。

第三类是 suite 级问题，不能用单个测试的通过/失败矩阵代替。新增测试必须提供一个 **witness**：某个现实、契约相关的最小错误或边界，在没有该测试时仍会被相关测试集合接受，而加入该测试后会失败。找不到 witness 的新增判定是冗余候选。

## 1. 建立测试 census

先枚举，再判断。为 diff 中每个新增或修改的 test case、参数行、assertion、snapshot、fixture、mock 和 test helper 建立一行工作稿；同一 test 内的每条新增或修改 assertion 也要进入 assertion 扫描。生产变更使既有测试的错误判定重新可达时，也把这些既有测试加入 census。

按被测生产行为和测试层级分组，不按文件、class、函数名或 AI 生成批次分组。top-level test、class method、parameterized case 和 helper 包装后的 test 可以属于同一组。

完成条件：工作稿数量与 diff 中的测试改动逐项对齐；不能用“这组 matrix 总体有价值”代替逐个 case 的结论。

## 2. 为每个 case 建立 contract fingerprint

先从 PR 之前存在的 API、schema、协议、调用方、消费者、稳定文档和 base 行为恢复测试责任，再读取相关 base/head 测试与足以确定行为的生产代码，将每个 case 规范化为：

```text
contract responsibility / independent source：目标保证及其 PR 之前的依据
focal boundary：被测生产入口、外部边界和测试层级
precondition partition：由 guard、schema、协议或稳定契约划分的输入/状态等价类
boundary role：下界外、下界、内部、上界、上界外，或其他明确角色
actual path：输入到 observable actual 的决策和副作用路径
oracle / verdict path：测试准备、expected/matcher 的来源与最终 verdict
failure mode：哪类局部错误会使它失败
requirement/risk dimension：权限、租户、平台、并发、兼容性等独立维度
```

测试名、PR 正文、注释、当前 assertion 和 literal 只用于导航，不能自行创造 responsibility、requirement、partition 或 boundary。`short`、`medium`、`long`，以及 `openai`、`anthropic`、`google` 之类名称，只有在生产分支或 PR 之前的独立契约区别对待时才是不同 fingerprint。

完成条件：每个 changed case 都有独立责任依据、actual 路径、oracle/verdict 路径和 fingerprint，并列出同组 base case 与 sibling case；只写“输入不同”或从当前 assertion 反推责任不算完成。

## 3. 规范化 literal 与输入角色

先按生产条件和契约划分 partition，再比较具体值。以下扫描是必经项：

| 输入形状 | 应优先恢复的 partition | 通常不构成独立 witness 的变化 |
|---|---|---|
| 数值与长度 | 非法下界、恰好边界、内部值、溢出/饱和/精度边界 | 同一内部区间中的多个普通正数或多个普通超限长度 |
| 字符串与 label | 空值、显式枚举成员、保留值、非保留值、格式合法/非法、编码类别 | 同一个非保留 key 下更换任意普通 value |
| path 与 prefix | root、匹配、不匹配、traversal、drive-qualified、分隔符/平台差异 | 相同深度和形状下更换普通目录名或文件名 |
| collection | 空、单个、多个、重复、乱序、上限、分页边界 | 同一规模和顺序语义下更换普通成员 literal |
| 状态与身份 | 未认证、不同角色/租户/归属、前置态、终态、重试态 | 未参与任何 guard、权限或输出的任意名称变化 |

同一路径并不自动证明冗余；不同数据点也不自动证明价值。显式有限集合中的每个权限、identity 或协议成员可以有独立 witness，因为遗漏其中一个成员是现实局部错误；集合之外的多个任意值通常仍属于同一 partition。对无分支公式，额外输入向量只有在能区分现有表达式上的漏项、错项、错误比较符、精度或溢出等局部错误时才有价值。不得用“未来实现可能专门硬编码现有 fixture”“可以构造任意插值函数”之类只为区分样本而设计的实现作为 witness，除非生产代码或当前变更已经出现对应的数据依赖或特判风险。

完成条件：每个 literal 变化都被归入一个有代码或契约依据的 partition/boundary role；无法指出区别依据时按同一 partition 继续审查。

## 4. 执行 mandatory redundancy sweep

对每个 changed case 和 assertion 都执行以下扫描。代码形状只产生候选，最终结论由 fingerprint 与 witness 决定。

### 4.1 Duplicate assertion

将 assertion 规范化后比较。同一测试中，若两个 assertion 观察同一状态、表达式和 verdict，且中间没有 mutation、await、重试、迭代、时钟推进或有副作用的重新求值，后一个 assertion 的边际判定价值为零。

这类情况是可静态证明的 zero-marginal signal，不因其常被称为 test smell 而排除。若整个 test 已被更强的 suite-level redundancy finding 覆盖，在同一 finding 中说明；否则单独报告最接近的重复 assertion。

### 4.2 Exact、alpha-renamed 与 cross-granularity clone

忽略 test 名、局部变量名、class/top-level 包装和无语义中间变量，比较 setup、focal call、actual 和 oracle。相同输入角色与相同 verdict 的 clone 是高置信候选。

### 4.3 Assertion subsumption 与 partial duplicate

检查新增窄断言是否已被同一路径上的既有强断言蕴含，例如完整 payload equality 已经固定其中的 status，完整集合判定已经包含同一成员，或一个既有测试已同时验证新增测试的 setup、actual 和 oracle。

### 4.4 Data-clone family

当多个测试只有 literal、名称或局部变量不同，而 skeleton、partition、action/path 和 oracle template 相同时，将它们作为一个 family 审查，不逐个默认授予独立价值。

先找最小代表集：

1. base 已有代表时，所有没有 witness 的新增成员都是冗余候选；
2. base 没有代表时，保留能够覆盖该 fingerprint 的最小成员，其余成员必须分别提供 witness；
3. 不因把多个 member 改写成 parameterized test 就认为消除了冗余；参数化只减少代码重复，不增加故障检测能力。

### 4.5 Duplicate setup

相同 setup 本身不足以报告。只有 setup 后的 action/path、oracle 和 failure mode 也相同或被既有测试蕴含时，才进入 zero-marginal 候选；不同权限、事务、外部系统或状态序列可以合法复用相同 setup。

完成条件：每个 changed assertion 已检查重复/蕴含关系；每个结构相似或 literal-varying family 已列出全部成员、base 代表和最小代表集。

## 5. 要求 unique witness

对每个新增 case 做静态 deletion test：

```text
假设删除这个 case；哪一个现实、局部、契约相关的错误会因此通过其余相关测试？
```

有效 witness 必须同时说明：

1. 具体错误或行为边界是什么；
2. 它如何沿生产路径影响 actual；
3. 为什么 base 与保留的 sibling tests 仍会通过；
4. 为什么当前 case 会失败；
5. 该错误来自生产表达式、guard、状态机、外部契约或明确风险维度，而不是为测试数据量身构造。

常见有效 witness 包括：

- 新 guard/branch 或边界两侧与恰好边界；
- 独立的权限角色、租户、资源归属或敏感信息边界；
- 不同异常、终态、部分成功、重试、补偿或幂等状态；
- 平台、runtime、编码、路径分隔符、精度、溢出或序列化兼容；
- 并发、时序、顺序或资源清理；
- 不同外部 boundary、consumer、requirement 或 oracle；
- 一个现有测试不能杀死、但可由当前生产结构推导出的局部错误，例如漏字段、漏项、错误映射或错误比较符。

以下内容不构成 witness：不同 test 名、不同普通 literal、不同局部变量、重复执行同一路径、不同 fixture 描述，以及“多一个样本总会更保险”。

完成条件：每个保留的新增 case 都有 unique witness；没有 witness 的 case 进入 T2 zero-marginal 候选，不能以“输入不同”直接排除。

## 6. 分支审查 false confidence 与 change detector

witness 只回答 suite 边际价值，不能证明 oracle 正确、测试没有 false confidence 或没有过约束。对 census 中每个 case 独立筛查三种失败模式；没有候选依据的分支记录 `none` 及理由，有候选依据的分支只构造对应探针，不要求每个 case 完成所有探针。

### T1 false confidence：违反探针

从 PR 之前的独立契约构造一个测试声称拒绝的最小错误，分别追踪：

```text
错误输入/实现 → production actual
错误输入/实现 → 测试准备与 oracle → expected / matcher → verdict
```

若 expected 与 production 共用常量、helper、schema、formatter 或同一转换，或 mock/helper 绕过真实权限、事务、持久化和外部副作用，使错误仍得到成功 verdict，则为 T1 候选。必须证明当前 diff 使现有测试集合给出 false confidence，而不是单纯缺少更多测试。

### T2 change detector：允许探针

构造一个保持目标契约的现实变化，例如可扩展集合新增合法成员、无序结果改变遍历顺序、对象增加无关字段、私有 helper 被等价重构或逐项调用改成批处理。沿 actual 与 oracle/verdict 路径证明测试会失败，且没有独立契约要求被固定的属性，才是 T2 候选。

完成条件：每个 case 都有 T1、change-detector 和 zero-marginal 三个分支的筛查结论；T1 候选有可通过测试的违反探针，change-detector 候选有会被测试拒绝的允许探针，zero-marginal 候选有 deletion test 和缺失 witness 的证明。

## 7. 反证与 veto

对每个候选主动寻找独立价值。以下差异只有在生产代码、稳定契约或真实测试层级中可观察时才构成 veto：

- 认证、角色、租户、资源归属或安全 allowlist；
- 相邻边界值、有效/无效两侧、空值、极值、溢出和编码；
- 平台、runtime、数据库、协议版本或路径语义；
- 并发、时序、重试、部分成功、事务和清理；
- 不同 requirement、consumer、外部 oracle 或 unit/integration/contract 层级；
- 同一 assertion 文本在不同状态时刻或有副作用求值后的再次检查。

“值不同”“actor 不同”“测试名不同”不是默认 veto；必须指出该维度在哪里改变 guard、path、observable actual、oracle 或独立 requirement。

同时检查 base 是否已有同一冗余或误判、当前 diff 是否新引入/扩大/重新激活，以及生产 finding 是否已覆盖同一根因。

完成条件：每个候选记录最强 veto 及其成立或失败原因。

## 8. 分类与 finding granularity

### T1 — 测试失真

仅当当前 diff 新增、修改或放宽测试判定，且静态证明一个有独立契约的错误仍得到成功 verdict 时报告。

### T2 — 测试过约束

仅当现实允许变化会被新增/修改测试拒绝、被固定属性没有独立契约，并能指出更窄且完整的判定边界时报告。

### T2 — 冗余测试信号

仅当当前 diff 新增或修改判定，且以下条件均成立时报告：

- candidate 的 oracle 已被同一路径上的既有断言蕴含；或者 candidate 与 base/retained sibling 同时具有相同的规范化 responsibility、partition/boundary role、action/path、oracle 和 failure mode；
- deletion test 找不到现实 unique witness；
- 独立价值 veto 已被检查并失败；
- 后果是零边际故障检测、重复失败信号或同一契约的重复维护点。

finding 按 **redundancy cluster** 去重：只合并相同 focal behavior、partition/boundary role、oracle、failure mode 和测试层级的成员。不同生产符号、业务责任、外部边界或 failure mode 是不同根因，不能因为都来自“AI 批量生成”“重复 base coverage”或同一个 PR 策略而合并。

同一 test 整体冗余且内部还有 duplicate assertion 时，优先报告能够删除整个冗余 test 的 cluster finding，并把重复 assertion 作为补充证据；若 test 本身有独立 witness，则只报告其中的 duplicate assertion。

生产代码已构成 P0/P1/P2，而测试只是同步背书同一错误时，只报告生产 finding；测试误判具有独立根因时保留 T finding。

## 工作稿完成格式

```text
changed case / assertion：
contract responsibility / independent source：
focal boundary / test layer：
partition / boundary role：
actual path：
oracle / verdict path：
failure mode：
base 与 sibling 覆盖：
unique witness：
redundancy sweep：duplicate / subsumed / data family / none
branch screen：T1 / change-detector / zero-marginal
最强 veto：
探针：deletion / violating / allowed / none
结论：保留 / T1 / T2-change-detector / T2-zero-marginal / 并入生产 finding
cluster key：
```

最终完成条件：

- 每个 changed case 和 assertion 都有独立责任、actual/oracle 路径和三类失败模式的筛查结论；
- 每个 literal-varying family 都有最小代表集；
- 每个保留成员都有明确 witness；
- 每个冗余 cluster 单独归因，没有跨业务责任过度合并；
- 没有以测试通过、CI 绿色、输入不同或“只是 smell”为由跳过静态可证明的 zero-marginal signal。
