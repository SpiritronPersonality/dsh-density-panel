# Density Compact 设计定稿

> DSH 上下文密度管理器 · v1.0  
> 状态：设计定稿，不含实现代码，不执行。  
> 日期：2026-11-04  
> 目标：提升信息密度、推迟 80% 原生大压缩、附带净节省 token。

## 0. 定稿摘要

一句话：**把任务状态留在窗口里，把原始内容放到窗口外，需要时一步取回。**

五个决定：

1. **四层预算**：锚点 / 工作层 / 归档层 / 余量。
2. **入口预压缩**：工具结果进上下文前按类型瘦身，缓存安全。
3. **抽取式小切**：刚结束的一轮压成硬事实卡，不调模型，前缀不动。
4. **状态板 + 可回查归档**：状态板常驻，原文落盘，`density_recall` 按需取回。
5. **原生 80% 只做兜底**：V1 不接管 `ctx.compaction`；触发时重注入锚点/状态板，降低损失。

三个拒绝：

- 拒绝固定比例阶梯（20% 第一刀、每 2w 一刀、4/6/8/10）。
- 拒绝热路径模型摘要。
- 拒绝“压缩即删除”；原文必须可回查。

成功标准（目标值，需 A/B 校准）：

| 维度 | 目标 |
|---|---|
| 质量 | 通过率 ±1pp；跨轮可靠性不劣化 |
| 推迟 80% | 长任务 tokens-to-80% +30%，或 ≥50% 长任务不触发 |
| 净成本 | −15% 以上（含 recall/summary/cache） |
| 锚点 | 完整率 100%；时间/数字保真不低于基线 |
| 检索 | 平均 ≤3 次/轮，≤4k token/次 |

## 1. 目标与非目标

### 1.1 目标（按优先级）

1. **密度**：提高“任务相关状态 / token”。
2. **推迟 80%**：降低上下文增长速率，尽量不触发原生大压缩。
3. **净节省**：压缩收益减去 recall、summary、cache 重置后的净 token/成本。
4. **可回查**：任何被移出窗口的原文，都能一步取回。
5. **安全**：锚点不丢、tool pairing 不破、失败开放。

### 1.2 非目标

- 不做通用 prompt 压缩器；不做 KV cache 压缩；不做模型训练。
- 不做跨会话长期记忆（V1 只做会话内）。
- 不追求“压缩比最大化”；不把“摘要写得漂亮”当目标。
- 不默认接管原生压缩；不默认让模型自己清历史。

### 1.3 成功标准

见 §0 表。所有目标值都是待验证假设，不是承诺；未达标按 §9.7 回滚。

## 2. 设计原则 / 不变量

- **P1 选择 > 比例**：先决定留什么，再决定压多少。
- **P2 预压缩 > 历史改写**：能在入口瘦身，就不要改已发送的前缀。
- **P3 抽取 > 摘要**：硬事实用抽取；语义归纳只做兜底。
- **P4 状态外化 > 保留轨迹**：状态板/文件/归档优先于“什么都留在上下文”。
- **P5 可逆 > 无损**：不承诺摘要无损，承诺原文可回查。
- **P6 never-worse**：压缩后 token/字节不降、硬事实缺失、pairing 不平衡，就不压。
- **P7 fail open**：tokenizer 不可用、spill 失败、宿主 API 不兼容，就保留原文。
- **P8 净账**：只按净节省评估，不按压缩比评估。
- **P9 单写者/原子事务**：压缩、归档、状态板更新要么全成，要么全不成。
- **P10 锚点不可变**：任务陈述、约束、格式、验收标准永不压缩。

## 3. 架构

### 3.1 四层预算

| 层 | 内容 | 压缩 | 预算 | 生命周期 |
|---|---|---|---|---|
| L0 锚点 | 原始任务、约束、格式、验收、未完成 | 0% | 10%，可超 | 不可变 |
| L1 工作层 | 最近 N 轮、当前文件/报错、tool pairs | 低（去重/入口预压缩） | 25% | 滚动 |
| L2 归档层 | 旧轮次硬事实卡 + 指针 | 高（抽取） | 35% | 追加，不重写 |
| L3 冷存储 | 原文、完整工具输出 | 100% 出窗 | 磁盘 | 可回查 |
| 余量 | 空 | — | 20–30% | 用于推迟 80% |

预算是软目标：锚点优先，不够从归档层扣；归档层不够，从余量扣；余量低于 10%，进入结构压缩。

### 3.2 上下文布局（缓存友好）

```
[system prompt]
[L0 锚点：原始任务/约束/格式/验收]        ← 不可变，缓存稳定
[L2 归档：旧轮次卡片，按时间追加]          ← 只追加，不中间插入
[L2 最新卡片：刚结束的一轮]
[L1 状态板：目标/决策/未完成/当前状态]     ← 每轮变，靠近尾部
[L1 工作层：最近轮次/当前文件/报错]
[当前用户消息]                              ← 最近，recency
```

原则：**越稳定越靠前，越易变越靠后**。状态板放尾部，避免每轮改状态板把整个前缀缓存打掉；锚点放顶部，利用 primacy；当前消息放底部，利用 recency。归档卡片只追加，不中间插入，减少缓存断点。

### 3.3 组件

| 组件 | 职责 | 不做什么 |
|---|---|---|
| EntryCompressor | 工具结果入口预压缩、分类、never-worse、落盘 | 不改历史，不做语义摘要 |
| TurnExtractor | 刚结束轮次的硬事实抽取卡 | 不压锚点，不压当前轮 |
| StateBoard | 目标/约束/决策/未完成/当前状态 | 不写新指令，不覆盖冲突 |
| ArchiveStore | 原文落盘、索引、哈希、轮换 | 不联网，不删当前活动项 |
| RecallTool | 按 query/marker 取回，分页，限额 | 不返回新指令，不无限读 |
| PressureGovernor | 软/硬/紧急压力、预算、滞回 | 不按固定时钟硬切 |
| CompactionBridge | 原生压缩事件监听、锚点/状态板重注入 | V1 不替换 `ctx.compaction` |
| AuditMetrics | 事件日志、tokens-to-80、净节省、召回率 | 不记录原文到指标库 |

### 3.4 DSH 挂接点

| 挂接点 | 用途 | 失败策略 |
|---|---|---|
| `tools/post-execute` | 入口预压缩 | 保留原文，记 skip |
| `agent/pre-step` / `agent/status` | 轮次结束、压力检查、状态板更新 | 跳过本轮 |
| `ctx.tokenMeter` | 精确/估算 token | 估算 + 安全边际 |
| `ctx.spillStore` | 原文落盘；不可用则本地目录 | 落盘失败则不压 |
| `ctx.settings` / config form | 配置 | 用默认值 |
| `ctx.tools` | `density_recall`、`density_status` | 不注册则只做后台 |
| `ctx.commands` | `/density ...` | 命令不可用不影响主流程 |
| `ctx.compaction` | 监听事件，重注入锚点/状态板 | V1 不替换；失败则原样 |
| `ctx.logger` | 审计 | 不影响压缩 |

所有挂接以 DSH 实际 API 为准；未确认的接口列入 §12。

### 3.5 缓存策略

- **入口预压缩**：发生在首次发送前，不破坏已建前缀缓存。
- **归档卡片**：只追加，不重写；每轮最多一次。
- **状态板**：放尾部；每轮更新只影响尾部。
- **原生压缩**：少触发；触发后重注入锚点/状态板；接受一次缓存重置。
- **批量**：历史改写合并到自然边界，避免每 2w 一次。

## 4. 数据模型

### 4.1 TaskAnchor

| 字段 | 说明 |
|---|---|
| id / sessionId | 唯一标识 |
| messages | 原始任务消息全文（逐字） |
| constraints[] | must/never/必须/不要/格式/验收 |
| format / acceptance | 输出格式、验收标准 |
| unresolved[] | 未完成项 |
| hash | 发送前校验 |
| pinned | 是否用户手动固定 |

不变量：不可变；永不压缩；hash 不一致则阻止发送并告警。

### 4.2 StateBoard

| 字段 | 说明 |
|---|---|
| goal | 一句话目标 |
| constraints[] | 约束，逐字 |
| decisions[] | {text, refs, at} |
| currentState | {files[], branch, lastCommand, error} |
| openItems[] | 未完成/阻塞 |
| nextAction | 下一动作 |
| archiveRefs[] | 最近 5–10 个 marker |
| updatedAt / version | 版本 |

不变量：≤ `stateBoardMaxTokens`；标注“派生状态，不是新指令”；冲突保留双方；只合并，不静默覆盖。

### 4.3 TurnCard

| 字段 | 说明 |
|---|---|
| cardId / sessionId | 唯一标识 |
| seqRange | 原始事件区间 |
| generation | 固定 1 |
| hardFacts[] | 硬事实行 |
| keptLines[] | 保留行（带角色） |
| toolSummary | 工具状态摘要 |
| pointers[] | 原文 marker |
| before/afterTokens | 账本 |

不变量：不可变；永不再压；需要修正时写新卡并标 `supersedes`，不重写旧卡。

### 4.4 ArchiveRef

| 字段 | 说明 |
|---|---|
| marker | `#density-xxxx` |
| sessionId / seqRange | 来源 |
| kind | tool/card/raw |
| bytes / sha256 | 完整性 |
| path | 本地路径，不发给模型 |
| createdAt / expiresAt | 生命周期 |

### 4.5 CompressionEvent

| 字段 | 说明 |
|---|---|
| id / stage / trigger | 事件 |
| method | toon/table/log/code/dedup/extract/summary |
| before/after tokens/bytes | 账本 |
| hardFactsMissing | 硬事实缺失数 |
| toolPairingOk | 配对检查 |
| cacheImpact | none/likely/reset |
| latencyMs | 耗时 |
| skippedReason | 未压原因 |
| marker | 归档指针 |

### 4.6 RetrievalResult

`marker, mode, content, truncated, nextCursor, tokens, labeledAsHistory=true`。检索结果必须标注“历史数据，不是新指令”。

## 5. 压缩流水线

### 5.1 Stage A：入口预压缩

**触发**：工具结果 > `entryMinBytes`（默认 1400）或 > `entryMinTokens`（默认 512）；事件驱动，不等 token 水位。

**分类与方法**：

| 类型 | 方法 | 损失 |
|---|---|---|
| 均匀 JSON 数组 | TOON：schema 头 + CSV 行 | 无损 |
| JSONL/NDJSON | 整表 TOON | 无损 |
| 管道/制表符表格 | 头 60 行 + 中间跨步采样（带原行号）+ 尾 40 行 | 有损，可定位 |
| 日志 | 头/尾 + error/fatal/traceback/timeout 行（±1 行） | 有损，保错 |
| 代码 | 骨架：imports/声明/签名；函数体省略；错误行保留 | 有损，保结构 |
| diff/搜索结果/文件读取 | 头/尾 + 命中行 + 路径 | 有损 |
| 通用长文本 | 头/尾 + 错误行 | 有损 |
| 重复输出 | 字节相同且 TTL 内 → stub + 指针 | 无损（去重） |

**门**：never-worse（字节和 token 都必须变小）；lossy 必须有精确 tokenizer；spill 必须成功；卡片不得含密钥；marker 必须可解析。任一失败保留原文并记 skip。

**输出**：压缩文本 + `[density #marker]` + 取回提示；原文进 ArchiveStore。**缓存**：安全，不改历史。

**豁免**：`density_recall` 的输出、当前文件读取、当前轮工具结果不进入入口压缩（留在工作层）。

### 5.2 Stage B：轮次抽取

**触发**：轮次结束；该轮 > `turnMinTokens`（默认 4096）；上下文 > 20k；自然边界。

**硬事实分类**：

| 类别 | 例子 | 处理 |
|---|---|---|
| 义务 | must/never/required/必须/不要/禁止 | 逐字保留 |
| 决策 | “用 X 不用 Y”“已确认” | 保留 + 理由 |
| 事实 | 路径、ID、版本、数字、日期、URL、命令、错误码 | 逐字保留 |
| 状态 | 当前文件、失败测试、最后命令、报错 | 进状态板 |
| 未完成 | TODO、blocked、待确认 | 进状态板 |
| 用户意图 | 短用户消息、纠正 | 逐字保留 |

**卡片格式**：

```
[density card #id | turn N | seq a-b]
Goal: ...
Constraints: ...
Decisions: ...
Facts: paths / IDs / numbers / dates / commands
Errors: ...
Open: ...
Tools: [ok/fail/unknown] ...
Refs: #marker
```

**方法**：按硬事实分数排序，保留到 `maxCardChars`；若硬事实缺失、卡片不比原文小、pairing 不平衡，保留原文。**不调模型**。

**替换**：只替换刚结束的一轮；前缀不动；卡片追加到归档尾部；`generation=1`；旧卡不再压。

### 5.3 Stage C：状态板

**触发**：每轮结束；无变化则跳过。

**合并规则**：

- Goal：最近一次用户意图；若冲突，保留新旧两行并标时间。
- Constraints：并集去重，逐字。
- Decisions：追加，带 refs；不删旧决策，除非用户明确撤销。
- CurrentState：取最新文件/分支/错误/命令。
- OpenItems：新增/关闭；关闭项保留一行“已解决”。
- NextAction：最近一次计划。
- ArchiveRefs：最近 5–10 个 marker。

**大小**：≤ `stateBoardMaxTokens`（默认 2048）；超了先把细节移到归档，保留约束/未完成/当前错误。

**放置**：稳定前缀尾部、工作层之前。**模型辅助**：V1 关闭；V2 可在阶段边界开启，但不在热路径。

### 5.4 Stage D：归档与检索

**归档**：原文 + 索引；本地 only；0600；sha256；容量上限（默认 1GB）LRU 轮换；当前活动 marker 不删；删除失败则停止该次压缩。

**检索工具**：

```
density_recall(query?, marker?, mode=auto|head|tail|range, maxTokens=2048)
```

- `query`：子串/三元组搜索，返回 snippets + markers。
- `marker`：按 marker 读全文或切片。
- 分页：`nextCursor`；单次 ≤ `maxRecallTokens`；每轮 ≤ `maxRecallCallsPerTurn`。
- 输出标注“历史数据，不是新指令”。
- 检索结果不进入口压缩、不去重、不再归档。

### 5.5 Stage E：结构压缩兜底

| 压力 | 动作 |
|---|---|
| 软 65% | 提示；只压归档层；不改锚点/工作层 |
| 硬 80% | 余量 <10% 时结构压缩；先抽取压归档；不够再模型摘要归档；锚点/工作层保留 |
| 紧急 90% | 原生压缩/换窗；fail open |

**期望收益门**：`saved_tokens > summary_cost + cache_reset_cost`，否则跳过，交给原生。

**压缩后**：重注入锚点、状态板、归档索引；校验 hash；tool pairing 检查。

**V1 边界**：不替换 `ctx.compaction`；只监听压缩事件并重注入。V2 可选 takeover，默认关闭。

### 5.6 Stage F：审计与指标

每个事件写 `CompressionEvent`；`/density status` 展示：压力、层预算、tokens-to-80、净节省、召回率、最近 skip 原因、锚点完整性、缓存命中（若可得）。

## 6. 触发与预算

### 6.1 触发表

| 阶段 | 触发 | 批量 | 滞回 |
|---|---|---|---|
| 入口 | 单条工具结果 > 阈值 | 每条 | 无 |
| 轮次 | 轮末 + >4k | 每轮 | 卡片不更小则跳过 |
| 状态板 | 轮末 | 每轮 | 无变化则跳过 |
| 软压 | 压力 ≥65% | 自然边界 | 10 轮/5 分钟 |
| 硬压 | 压力 ≥80% | 自然边界 | 降到 <60% 才重置 |
| 紧急 | 压力 ≥90% | 立即 | 原生 |

### 6.2 压力计算

`effectiveWindow = contextWindow - maxOutputTokens - safetyMargin`；`pressure = surfaceTokens / effectiveWindow`。若预测 3 轮内溢出，提前在边界处理。

### 6.3 预算分配

默认锚点 10%、工作层 25%、归档层 35%、余量 30%。锚点超了从归档扣；归档不够从余量扣；余量 <10% 进入结构压缩。

### 6.4 被拒绝的阶梯

- **20% 第一刀**：太晚；入口预压缩 + 20k 抽取更早降低增长速率。20% 只保留为“结构压缩兜底阈值”。
- **每 2w 一刀**：太机械；按自然边界 + 可压增量（30–50k）+ 压力触发。
- **4/6/8/10**：比例阶梯忽略内容类型；改为“按类型选方法 + never-worse + 保留率下限”。

## 7. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `mode` | `balanced` | `shadow`/`entry`/`turn`/`full` |
| `entryMinBytes` | 1400 | 入口压缩最小字节 |
| `entryMinTokens` | 512 | 入口压缩最小 token |
| `turnMinTokens` | 4096 | 轮次抽取最小 token |
| `softPressure` | 0.65 | 软压 |
| `hardPressure` | 0.80 | 硬压 |
| `emergencyPressure` | 0.90 | 紧急 |
| `headroomRatio` | 0.25 | 余量 |
| `anchorMaxRatio` | 0.10 | 锚点软预算 |
| `workingMaxRatio` | 0.25 | 工作层 |
| `archiveMaxRatio` | 0.35 | 归档层 |
| `recentTokens` | 32000 | 工作层保留 |
| `maxCardChars` | 8000 | 单卡上限 |
| `maxRecallTokens` | 4096 | 单次检索上限 |
| `maxRecallCallsPerTurn` | 3 | 每轮检索次数 |
| `dedupeTtlMs` | 600000 | 去重窗口 |
| `tableHeadRows` / `tableTailRows` | 60 / 40 | 表格保留 |
| `tableStride` | 50 | 表格跨步 |
| `errorLineRadius` | 1 | 错误行上下文 |
| `codeSkeleton` | false | 代码骨架默认关 |
| `tokenizerMode` | `exact` | `exact`/`estimate`；lossy 必须 exact |
| `stateBoardMaxTokens` | 2048 | 状态板上限 |
| `stateBoardModelAssist` | false | V1 关闭 |
| `failOpen` | true | 失败保留原文 |
| `audit` | true | 事件日志 |
| `archiveMaxBytes` | 1073741824 | 归档上限 |

预设：

- `shadow`：只测量，不改写。
- `safe`：只做入口 + 抽取，不做结构压缩。
- `balanced`：默认，入口 + 抽取 + 状态板 + 归档 + 软/硬压。
- `aggressive`：更低阈值、更高压缩，仅用于评测。

按模型覆盖：`overrides: { "deepseek-v4-pro": { ... } }`。CJK 估算按 2 字符/token；lossy 仍要求 exact。

## 8. 工具与命令

**工具**：

- `density_recall(query?, marker?, mode, maxTokens)`：历史检索/原文取回。
- `density_status()`：压力、预算、净节省、召回率、锚点完整性。

**命令**：

- `/density status`
- `/density compact`：手动结构压缩（走期望收益门）
- `/density pin <seq|range>` / `/density unpin`
- `/density audit [n]`
- `/density purge`：删除本会话归档（二次确认）

**V1 不提供**模型可调用的 `clear_mind`/`new_context`。模型只能读归档，不能改历史；清理由人/压力引擎触发。

## 9. 评估

### 9.1 假设

- **H1**：入口预压缩降低增长速率和净成本，质量不回归。
- **H2**：轮次抽取推迟 80%，锚点不丢。
- **H3**：状态板 + 归档比原生摘要密度更高。
- **H4**：never-worse 门能避免过度压缩导致的 reacquisition。

### 9.2 指标

| 类别 | 指标 |
|---|---|
| 主指标 | 任务通过率；tokens-to-80%；净成本 |
| 次指标 | 峰值上下文；retrieval calls；re-read 率；延迟；cache hit；压缩事件数 |
| 保真 | 锚点完整率；约束命中；时间/数字保真；逐字取回成功率 |
| 护栏 | tool pairing 错误；spill 失败；skip 率；安全事件 |

### 9.3 基准

SWE-bench Verified、Terminal-Bench 1.0/2.0、WebUniverse/agentic search、长编码会话、1M needle/temporal 探针；多轮、多次运行。

### 9.4 A/B 臂

1. 原生基线。
2. 仅入口预压缩。
3. 入口 + 轮次抽取。
4. 全量（+ 状态板 + 归档 + 兜底）。
5. 消融：去状态板、去归档、去锚点 pin、去 never-worse。

### 9.5 逐事件评估

每个压缩事件做配对续跑（同状态，有/无压缩），记录失败类型：锚点丢失、时间/数字错、tool pairing、重复探索、无法取回。参考 TRACE/PAIR 的边界评估。

### 9.6 验收阈值

| 维度 | 通过 |
|---|---|
| 质量 | 通过率下降 ≤1pp；可靠性不劣化 |
| 推迟 | tokens-to-80% +30%，或 ≥50% 长任务不触发 |
| 净成本 | −15% 以上 |
| 检索 | ≤3 次/轮；逐字取回 ≥90% |
| 锚点 | 100% |
| 延迟 | p95 开销 ≤10% |

### 9.7 回滚

质量 −1pp 以上、净成本没有 −10%、召回 >5 次/轮、锚点 <100%、tool pairing 错误 >0：关闭对应阶段，回到上一模式。

## 10. 风险与对策

| 风险 | 影响 | 对策 | 检测 |
|---|---|---|---|
| 锚点丢失 | 任务跑偏 | 锚点不可变 + 压缩后重注入 + hash | 发送前校验 |
| 语义丢失 | 答案变差 | 抽取卡 + 归档 + 状态板 | 逐字/约束探针 |
| Reacquisition | 省 token 反变贵 | 检索限额 + 工作层保护 | recall 次数/净账 |
| 缓存破坏 | 成本上升 | 入口预压缩 + 只追加 + 状态板靠尾 | cache hit |
| Tokenizer 不匹配 | 误判 never-worse | lossy 必须 exact，否则 fail open | tokenizer 探针 |
| Tool pairing 破 | 请求 400 | 原子事务 + 配对检查 | 发送前检查 |
| 过度压缩 | 质量/成本双输 | 保留率下限 + 净收益门 | A/B |
| 检索滥用 | token 涨回 | 每轮限额 + 告警 | recall 率 |
| 安全 | 原文泄露 | 本地 only、0600、卡片脱敏、purge | 权限/审计 |
| 模型差异 | 策略失效 | 按模型覆盖 + 分模型评测 | A/B |
| DSH API 变更 | 插件失效 | 适配层 + fail open | 启动自检 |
| 子代理 | 状态串扰 | 每 agent 独立状态板/归档 | 会话隔离 |

## 11. 实施阶段（不执行）

| 阶段 | 内容 | 门 |
|---|---|---|
| P0 shadow | 只测量，不改写 | 潜在节省 >20%，锚点 100% |
| P1 entry | 入口预压缩 | 净成本 −10%，质量不回归 |
| P2 turn+state | 抽取 + 状态板 | tokens-to-80% +20%，质量不回归 |
| P3 archive/recall | 归档 + 检索 | recall ≤3/轮，逐字 ≥90% |
| P4 fallback | 原生压缩重注入/兜底 | 压缩后恢复不劣化 |
| P5 tuning | 分模型/任务预设 | 三类任务稳定 |

本文不执行任何阶段；阶段表只用于后续实施计划。

## 12. 开放问题

1. DSH 原生 `compaction-basic` 是否保留首条用户消息/检查点？需要读实现确认。
2. `tools/post-execute` 与其他压缩插件（selector/save-token）的挂接顺序与冲突如何仲裁？
3. 目标模型的精确 tokenizer 是否可得？非 DeepSeek 路由如何 fail open？
4. 状态板注入用 system 还是 user 角色？是否影响缓存与指令优先级？
5. 子代理是否共享归档？父/子状态板如何合并？
6. `density_recall` 的查询语法与模型使用习惯；如何防止过度召回？
7. 1M 窗口的有效上下文是否远低于标称？软压是否应降到 60%？
8. 状态板是否需要模型辅助合成？成本/收益比如何？
9. 归档上限、保留期、purge 的产品语义；是否允许跨会话？
10. 评估基准与 tokens-to-80 的测量口径；如何做跨模型可比？

## 13. 定稿结论

**设计定稿：四层预算 + 入口预压缩 + 抽取式小切 + 状态板 + 可回查归档 + 原生 80% 兜底。**

- 先做“降低增长速率”，再做“结构压缩”；不先做“更高压缩比”。
- 先做“可逆归档”，再做“摘要”；不把摘要当唯一记忆。
- 先做“锚点/状态板”，再做“动态比例”；不按水位阶梯压。
- V1 不接管原生压缩；只让原生压缩更晚发生、发生时损失更小。

**下一步不是写代码，而是按 §9 做 P0 shadow 的测量设计；未通过 P0 门，不进入实现。**

## 附录 A：硬事实分类

| 类别 | 规则/例子 | 保留方式 |
|---|---|---|
| 义务 | must/never/required/必须/不要/禁止/只能 | 逐字 |
| 决策 | decided/chosen/use X not Y/已确认 | 逐字 + 理由 |
| 路径 | `/...`、`src/...`、文件名 | 逐字 |
| 标识符 | 变量、函数、类、错误码、端口 | 逐字 |
| 数字/时间 | 版本、金额、日期、超时、阈值 | 逐字 |
| 命令 | `npm ...`、`git ...`、`bash ...` | 逐字 |
| 错误 | Error/Exception/Traceback/FAILED/panic | 首行 + 末 2 行 |
| 未完成 | TODO/FIXME/blocked/待确认 | 进状态板 |
| 用户意图 | ≤280 字用户消息、纠正 | 逐字 |

## 附录 B：方法矩阵

| 内容 | 首选 | 回退 | 永不 |
|---|---|---|---|
| 均匀 JSON | TOON 无损 | 头/尾 | 盲切中间 |
| JSONL | 整表 TOON | 头/尾 | 逐行截断 |
| 表格 | 头/尾 + 跨步 + 行号 | 头/尾 | 只留前 N 行 |
| 日志 | 头/尾 + 错误行 | 头/尾 | 丢错误行 |
| 代码 | 骨架 | 头/尾 + 错误行 | 删签名 |
| 通用长文 | 头/尾 + 错误行 | 全文保留 | 模型摘要（V1） |
| 重复输出 | 去重 stub | 原文 | 保留两份 |

## 附录 C：配置示例

```yaml
density:
  enabled: true
  mode: balanced
  entryMinBytes: 1400
  entryMinTokens: 512
  turnMinTokens: 4096
  softPressure: 0.65
  hardPressure: 0.80
  emergencyPressure: 0.90
  headroomRatio: 0.25
  anchorMaxRatio: 0.10
  workingMaxRatio: 0.25
  archiveMaxRatio: 0.35
  recentTokens: 32000
  maxCardChars: 8000
  maxRecallTokens: 4096
  maxRecallCallsPerTurn: 3
  dedupeTtlMs: 600000
  tableHeadRows: 60
  tableTailRows: 40
  tableStride: 50
  errorLineRadius: 1
  codeSkeleton: false
  tokenizerMode: exact
  stateBoardMaxTokens: 2048
  stateBoardModelAssist: false
  failOpen: true
  audit: true
  archiveMaxBytes: 1073741824
```

## 附录 D：术语

- **锚点**：不可压缩的原始任务/约束/格式/验收。
- **状态板**：从卡片和工具状态派生的常驻小状态，不是新指令。
- **卡片**：抽取式轮次摘要，保留硬事实和指针。
- **归档**：原文落盘 + marker + 索引。
- **never-worse**：压缩后字节/token 必须变小，硬事实不能少。
- **tokens-to-80**：从任务开始到上下文达到 80% 原生压缩阈值所消耗的 token。
- **净节省**：原始 token − 压缩后 token − recall token − summary token − cache 重置成本。
