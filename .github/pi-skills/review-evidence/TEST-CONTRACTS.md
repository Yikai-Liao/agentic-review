# Test contract review

只审查当前 diff 改动的测试、parameter row、assertion、fixture、snapshot、mock、test helper，以及生产变更使既有测试错误判定重新可达的情况。单纯缺少测试、覆盖率或更多用例不属于本专项。

测试审查有三种彼此独立的失败模式：

- **T1 false confidence**：测试接受了它声称拒绝的错误；
- **T2 change detector**：测试拒绝契约允许的变化；
- **T2 zero-marginal signal**：测试本身可以正确，但相对现有 suite 没有新增故障检测能力，只增加重复失败信号和维护点。

第三类是 suite 级问题。新增判定需要一个现实、契约相关的 **unique witness**：没有它时相关测试集合仍会接受某个局部错误，加入后才失败。以下示例只帮助恢复责任、选择探针和追踪 verdict，不是逐项执行或按形状匹配的 checklist，也不能直接决定 finding。

## 1. 建立 census、fingerprint 与 evidence batch

先枚举，不同时完成全部分析。为 diff 中每个新增或修改的 test case、parameter row、assertion、snapshot、fixture、mock 和 test helper 建立稳定 census ID；同一 test 内的每条 changed assertion 都进入 assertion 扫描。生产变更使既有测试错误判定重新可达时，也加入对应测试。

每行只记录：

```text
census ID / 类型 / 位置
受影响 test case
候选 contract family / fingerprint
所在 evidence batch
```

**contract family** 只共享测试责任、生产边界和测试层级。**contract fingerprint** 在 family 内进一步绑定 partition/boundary role、actual path、oracle/verdict path、failure mode 和独立风险维度；任一字段不同都建立独立 fingerprint。

fixture、mock 或 helper 可以同时关联多个 family 和 fingerprint；每条 `census item → fingerprint` 关联都必须得到结论，不能要求共享 item 恰好属于一个 family、fingerprint 或 batch。

**evidence batch** 只负责复用读取和控制推理规模：需要相同 base/head 测试、生产文件和独立契约来源的 fingerprint 放在同一 batch。一个 batch 可以包含多个 family、fingerprint 和最终 finding cluster；同批处理不代表同根因。小 diff 的直接证据相同时只建立一个 batch。

完成条件：全部 census item 及其受影响 fingerprint 关联已经枚举；没有用“这组 matrix 总体有价值”代替逐项覆盖。

## 2. 每个 batch 单遍建立共享证据

一次读取当前 batch 所需的 base/head 测试、生产代码和 PR 之前的独立契约。在进入下一 batch 前完成本节至第 7 节；后续章节是同一次 fingerprint 分析的字段，不是对全 suite 的多轮扫描。

每个 family 只共享以下字段：

```text
contract responsibility / independent source：目标保证及其 PR 之前的依据
focal boundary / test layer：生产入口、外部边界和测试层级
```

每个 fingerprint 分别建立：

```text
precondition partition / boundary role：guard、schema 或协议定义的等价类及边界角色
actual path：输入到 observable actual 的决策和副作用路径
oracle / verdict path：准备、expected/matcher 来源与最终 verdict
failure mode：哪类局部错误会使测试失败
requirement/risk dimension：权限、租户、平台、并发、兼容性等独立维度
base / retained representative：现有覆盖和最小代表
```

member 只记录相对 fingerprint 和代表的真实语义差异；没有差异时写 `none`。测试名、PR 正文、注释、当前 assertion 和 literal 只用于导航，不能自行创造 responsibility、partition 或 boundary。

## 3. 先规范化输入，再选择代表

先按生产条件和契约划分 partition，再比较具体值：

| 输入形状 | 应优先恢复的 partition | 通常不构成独立 witness 的变化 |
|---|---|---|
| 数值与长度 | 非法下界、恰好边界、内部值、溢出/饱和/精度边界 | 同一内部区间中的多个普通正数或多个普通超限长度 |
| 字符串与 label | 空值、枚举成员、保留值、非保留值、格式或编码类别 | 同一非保留 key 下更换普通 value |
| path 与 prefix | root、匹配、不匹配、traversal、drive-qualified、平台分隔符 | 相同深度和形状下更换普通目录名或文件名 |
| collection | 空、单个、多个、重复、乱序、上限、分页边界 | 同一规模和顺序语义下更换普通成员 literal |
| 状态与身份 | 未认证、角色/租户/归属、前置态、终态、重试态 | 未参与 guard、权限或输出的任意名称变化 |

同一路径不自动证明冗余，不同数据点也不自动证明价值。显式有限集合中的权限、identity 或协议成员可能各有 witness；集合外的多个普通值通常仍属同一 partition。无分支公式的额外输入只有能区分漏项、错项、错误比较符、精度或溢出等现实局部错误时才有价值；不得为区分样本虚构生产代码不存在的数据特判。

生产 guard、schema 或协议明确区分的恰好边界是独立 boundary role；下界、边界、内部值、上界和上界外不能因当前实现偶然返回相同值而互相蕴含。若 base 没有覆盖同一个明确 boundary role，该 case 通过独立价值 veto，不得要求用相邻 partition 的当前实现构造额外 witness；只有测试名或 literal 自称“boundary”、但生产代码和 PR 前契约没有对应分界时，才按普通值处理。

每个 data family 选择 base 或最小 retained representative；member 只与同一 fingerprint 的代表比较，不做 family 内或全 suite 两两比较。发现独立责任、partition、actual/oracle path、failure mode、风险维度或测试层级后建立新的 fingerprint；共享证据相同时仍可留在同一 batch，最终 finding 再按 cluster key 去重。

## 4. Branch router：只进入有触发依据的分支

先按 changed item 对 verdict 的作用路由。形状只决定调查分支，不决定 finding；无法确定是否适用时进入该分支，不能用 router 排除风险。

| 当前变化 | 必查分支 |
|---|---|
| 新增/修改 test、parameter row、assertion 或 snapshot | zero-marginal；改变 actual/oracle 时同时检查 T1 和 change-detector |
| fixture、mock 或 helper 改变真实调用、输入或 expected 来源 | T1；固定额外 verdict 属性时检查 change-detector；新增重复判定信号时检查 zero-marginal |
| expected 与生产常量、schema、formatter 或转换共享真相源 | T1 |
| assertion 固定顺序、完整对象、私有字段、精确诊断或调用形状 | change-detector |
| production 变化使既有测试的错误判定重新可达 | T1 |

同一 fingerprint 中的 member 共享 router 结论；member 只覆盖自身差异。未触发分支记录共享的 `not applicable` 及触发规则，不逐 member 重复展开三套完整证明。

## 5. 对适用分支完成最小证明

### 5.1 T1 false confidence：违反探针

先锁定 changed test 的实际责任。mock/stub 提供下层错误、返回值或副作用以测试调用方的传播、映射或展示时，responsibility 是最近的未 mock 调用方边界，不自动包含被替换的下层 producer contract。只有 PR 前独立契约要求该 case 执行真实 producer 路径，或当前 diff 使 suite 失去该 producer 的独立真实路径判定时，才按绕过下层边界进入 T1；测试名、预制错误文本和 mock 自身不能扩张责任。

从 PR 之前的独立契约构造一个测试声称拒绝的最小错误，分别追踪：

```text
错误输入/实现 → production actual
错误输入/实现 → 测试准备与 oracle → expected / matcher → verdict
```

若 expected 与 production 共用常量、helper、schema、formatter 或同一转换，或 mock/helper 绕过真实权限、事务、持久化和外部副作用，使错误仍得到成功 verdict，则为 T1 候选。必须证明当前 diff 使现有测试集合给出 false confidence，而不是单纯缺少更多测试。

### 5.2 T2 change detector：允许探针

构造一个保持目标契约的现实变化，例如可扩展集合新增合法成员、无序结果改变遍历顺序、对象增加无关字段、私有 helper 等价重构或逐项调用改成批处理。沿 actual 与 oracle/verdict 路径证明测试会失败，且没有独立契约要求被固定属性，才是候选。

### 5.3 T2 zero-marginal：先 veto，再做 deletion proof

先检查独立价值：不同生产 guard、生产代码或契约明确划分且 base 未覆盖的 boundary role、权限/租户/归属、状态机分支、平台/runtime、编码、外部 consumer、真实 unit/integration/contract 层级或独立 oracle，能静态证明时立即保留该 member 并结束 redundancy 分支。相邻 partition 的测试不能替代明确边界本身。

没有独立价值 veto 时，对 family/cluster 执行以下 sweep；代码形状只产生候选：

- **Duplicate assertion**：同一测试中的 assertion 观察同一状态、表达式和 verdict，中间没有 mutation、await、重试、迭代、时钟推进或副作用求值；
- **Exact / alpha-renamed / cross-granularity clone**：忽略名称、class/top-level 包装和无语义中间变量后，setup、focal call、actual、oracle 与输入角色相同；
- **Assertion subsumption**：完整 payload equality 已蕴含 status，完整集合判定已包含同一成员，或既有测试已同时覆盖新增 setup、actual 与 oracle；
- **Data-clone family**：只有普通 literal、名称或局部变量变化，skeleton、partition、path 和 oracle template 相同；
- **Duplicate setup**：setup 相同本身不够；action/path、oracle 和 failure mode 也相同或被既有测试蕴含时才成为候选。

对 cluster 做一次静态 deletion test：

```text
删除这些 candidate member 后，哪一个现实、局部、契约相关的错误会通过其余相关测试？
```

有效 witness 必须说明：

1. 具体错误或行为边界；
2. 它如何沿生产路径影响 actual；
3. 为什么 base 与 retained sibling 仍会通过；
4. 为什么当前 member 会失败；
5. 错误来自生产表达式、guard、状态机、外部契约或真实风险，而非为样本量身构造。

常见有效 witness 包括新 guard 两侧与恰好边界、独立权限/租户/敏感信息边界、异常或终态、平台/runtime/编码/精度、并发时序和清理、不同 consumer 或一个现有测试杀不死但可从当前生产结构推导的漏字段、漏项、错误映射或比较符。不同 test 名、普通 literal、局部变量、fixture 描述、重复同一路径以及“多一个样本更保险”不构成 witness。

base 已有代表时，没有 witness 的新增成员进入候选；base 没有代表时保留覆盖该 fingerprint 的最小成员，其余成员必须提供 witness。参数化只减少代码重复，不增加故障检测能力。

## 6. 独立反证、归因与去重

对每个候选记录最强反证：该差异在哪里改变 guard、path、observable actual、oracle、独立 requirement 或测试层级。“值不同”“actor 不同”“测试名不同”不是 veto。

同时确认 base 是否已有同一误判/冗余、当前 diff 是否新引入/扩大/重新激活，以及生产 finding 是否已覆盖同一根因。生产代码已构成 P0/P1/P2、测试只是同步背书时只报告生产 finding；测试误判具有独立根因时保留 T finding。

## 7. 分类与 finding granularity

- **T1 测试失真**：当前 diff 新增、修改或放宽测试判定，且静态证明一个有独立契约的错误仍得到成功 verdict；
- **T2 测试过约束**：现实允许变化会被新增/修改测试拒绝、被固定属性没有独立契约，并能指出更窄且完整的判定边界；
- **T2 冗余测试信号**：candidate oracle 已被蕴含，或与代表具有相同 responsibility、partition、path、oracle、failure mode 和层级；deletion test 找不到 witness；独立价值 veto 失败；后果是零边际检测、重复失败信号或重复维护点。

finding 按 redundancy cluster 去重，只合并相同 focal behavior、partition/boundary role、oracle、failure mode 和测试层级的成员。不同生产符号、业务责任、外部边界或 failure mode 不能因为位于同一 evidence batch、来自“AI 批量生成”或都“重复 base coverage”而合并。

同一 test 整体冗余且内部还有 duplicate assertion 时，优先报告可删除整个 test 的 finding，并把重复 assertion 作为补充证据；若 test 有独立 witness，则只报告 duplicate assertion。

## 8. Batch checkpoint 与完成条件

每个 batch 完成后写入独立文件：

```text
batch ID / status：B1 / complete
evidence：读取的 base/head 文件与独立契约来源
coverage：census ID → contract fingerprint 的全部关联

family ID：
shared responsibility / focal boundary / test layer：

fingerprint ID：
partition / boundary role / actual path / oracle path / failure mode / risk dimension：
base / retained representative：
member deltas：
branch router：T1 / change-detector / zero-marginal / not applicable
candidate proof：violating / allowed / deletion / none
最强 veto：
结论：保留 / T1 / T2-change-detector / T2-zero-marginal / 并入生产 finding
cluster key：
finding 草稿：可直接发布的标题、位置、影响和证明 / none
```

正常情况下 complete batch 不复制进后续工作稿。新证据改变结论时重新打开并精确更新原文件；不能为遵守 checkpoint 形式保留已失效结论。

最终完成条件：

- 每个 census item 的全部 `item → fingerprint` 关联都被 complete batch 覆盖；
- 每个 family 只共享责任、生产边界和测试层级；每个 fingerprint 分别记录 partition、actual/oracle 路径、failure mode、风险维度和 branch 结论；member 只记录语义差异；
- 每个适用分支满足对应的 violating、allowed 或 deletion/witness 证明；
- 每个 literal-varying family 有最小代表集，每个保留的新 member 有独立 boundary 或 witness；
- finding cluster 没有因 batch 分组而过度合并；
- 最终只汇总 complete batch 的结论和 surviving finding 草稿，除关联冲突外不重新执行无 finding batch；
- 没有以测试通过、CI 绿色、输入不同、代码形状或“只是 smell”为由跳过静态可证明的问题。
