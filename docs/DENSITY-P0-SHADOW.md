# Density Compact · P0 Shadow 测量设计

> 上游：[DENSITY-DESIGN.md](DENSITY-DESIGN.md)（设计定稿 v1.0）
> 状态：测量设计，不含实现代码，不改动任何插件，不改动定稿。
> 日期：2026-11-04
> 目的：用只读影子证明"潜在节省 >20%、锚点 100%"，再决定是否进入 P1。

## 0. 一句话

**在模型编辑给出的真实窗口上，零改写地算清楚三件事：如果按定稿压缩能省多少、锚点会不会丢、什么时候会撞上原生压缩线。**

三条硬约束：

1. **不写上下文**：不改请求、不 append surface、不注册模型可见工具。
2. **不假设窗口**：W 只从模型编辑与请求上下文读；读不到就显示未知，不套 1M。
3. **实时对齐**：模型或窗口一变，分母立刻换，指标按 epoch 切段。

### 0.1 相对定稿的三处修正

P0 不是复述定稿，它校正了三个会影响结论的口径：

| # | 定稿写法 | P0 修正 | 原因 |
|---|---|---|---|
| 1 | 80% 是触发点 | 触发线是 `T = min(0.8W, W−O−B)`，B 默认 65,536 | 200K 窗口、O=8k 时实际在 131k 触发，不是 164k |
| 2 | 指标叫 tokens-to-80% | 改称 **TTC**（tokens-to-compaction） | 80% 只是名义值，T 才是真实线 |
| 3 | 锚点 100% 当门 | 改成"抽取召回 100% + 逐轮稳定 100%" | P0 不改写，锚点天然不丢，原门恒真、不可证伪 |

## 1. 门

| 门 | 条件 | 测法 |
|---|---|---|
| **G1 潜在节省** | ≥20 个真实会话，中位净潜在节省 ≥20% | §6 三级账，扣状态板与召回 |
| **G2 锚点** | 标注集召回 100%；逐轮 hash 稳定 100% | §7 |
| **G3 零改写** | 启用与不启用影子的请求逐字节相同 | §11.3 |
| **G4 对齐** | W 变更后 p95 ≤500ms 生效；epoch 切分 100% 正确 | §11.4 |
| **G5 开销** | 影子 p95 增量 ≤3%；新增模型 token = 0 | §11.5 |

处置：G1 不过 → 停止，回定稿 §9 重选方法。G2 不过 → 修抽取器重测，不降门。G3 不过 → 视为设计缺陷，先修再谈数据。

## 2. 真实上下文口径

### 2.1 唯一真源

```
设置 → 模型（模型编辑）providers[].models[].contextWindow
  → llm.resolveModelInfo(provider, model).context.contextWindow   实时值
  → session request/context 事件                                  当次请求实际值
  → tokenMeter.measure(session).surfaceTokens / totalTokens       分子
```

规则：

- 分母只用这条链路里的 W，不读常量，不解析模型名里的 "1m"/"128k" 后缀。
- `contextWindow` 在类型上可空；适配器不声明容量时 `W = null`，面板显示未知，指标不计入分母。
- 两个 W 都保留：`W_cfg`（现在配置多少）与 `W_eff`（上次请求实际用多少）。

### 2.2 原生触发线 T

定稿的"80%"是名义值。`compaction-basic` 的自动触发实际是：

```
T = floor( min( W × thresholdRatio, W − O − B ) )
  thresholdRatio 默认 0.8
  O = 当次请求输出预留（envelope.maxTokens → 适配器 defaultMaxTokens → 0）
  B = headroomTokens，默认 65536
```

200K 窗口（204,800）、O=8k 时：

```
T = min(163,840, 204,800 − 8,192 − 65,536) = 131,072   → 名义 80%，实际 64%
```

**结论：65k 的固定 headroom 主导了触发线。** 面板、压力、tokens-to-TTC 一律用 T，不用 0.8W。

换算成一张表（k=1024，O=8,192，B=65,536）：

| W | 0.8W | W−O−B | T | T/W | 主动压缩 |
|---|---|---|---|---|---|
| 32K | 26,214 | −40,960 | 22,528* | 69% | 无 |
| 64K | 52,429 | −8,192 | 55,296* | 84% | 无 |
| 128K | 104,858 | 57,344 | 57,344 | 44% | 有 |
| 200K | 163,840 | 131,072 | 131,072 | 64% | 有 |
| 256K | 209,715 | 188,416 | 188,416 | 72% | 有 |
| 384K | 314,573 | 319,488 | 314,573 | 80% | 有 |
| 1M | 838,861 | 974,848 | 838,861 | 80% | 有 |

\* 无主动压缩时按 `W − O − 2,048` 的安全线。

分界点 `W* = 5(O+B) = 368,640`（360K）：窗口大于它，80% 才重新成为约束；小于它，固定的 65.5k headroom 才是主约束。所以 128K 窗口实际在 44% 就压缩，256K 在 72%，只有 1M 才真是 80%。

### 2.3 小窗口没有原生兜底

`W − O − B ≤ 0` 时，`compaction-basic` 对该路由只告警一次并**跳过主动压缩**，仅保留溢出恢复。按 B=65,536、O=8,192 算：

```
W > 73,728   才有主动压缩兜底
```

所以小窗口模型（32k、64k）上：T 退化为 `W − O − S`（S 为安全边际），面板必须标 **"无原生兜底"**。不标，20% 的节省会被一次溢出错误吃掉。

### 2.4 三个量

| 量 | 含义 | 来源 | 用途 |
|---|---|---|---|
| `W_cfg` | 当前配置窗口 | `resolveModelInfo` | 配置真相 |
| `W_eff` | 上次请求实际窗口 | `request/context` | 请求真相 |
| `T` | 原生触发线 | §2.2 公式或实际观测 | 压力分母 |

计算用 `W_used = min(W_cfg, W_eff)`：

- 调小窗口 → 立刻按小值算，保守。
- 调大窗口 → 等下一次 `request/context` 追上再放宽。
- 两者不等 → 面板标"待对齐"（§3.3）。

### 2.5 上下文纪元 epoch

```
epochId = sha1(provider, model, W_used, O, T)
```

W 或模型一变就开新纪。理由：TTC、压力曲线、节省率的分母全变了，跨纪混算没有意义。

- 指标按 epoch 存；会话级只做加权汇总。
- 面板显示 `epoch n/m`，让人一眼看出这条会话换过窗口。

## 3. 实时对齐

### 3.1 变更源

| 源 | 事件 | 影响 | 动作 |
|---|---|---|---|
| 模型编辑保存 | `settings/document-updated(ns)` | W_cfg / O | 重新 resolve；变小立刻按新值算 |
| 会话切模型 | `session/event` → `request/context` | W_eff / 路由 | 开新 epoch |
| 适配器变化 | `llm/adapters-updated` | 可解析性 | 重新 resolve |
| 配置重载 | `app-boot/config-reload` | 全部 | 全量重算 |
| 原生压缩 | `session/event` → `compaction/start`、`compaction/end` | surface 变小 | 重测，记 TTC |
| 新建 / 恢复 | `agent/created` | 新会话 | 初始化 |
| 预设切换 | `agent-preset/selected` | 可能换模型 | 重新 resolve |

`settings/document-updated` 只给 namespace，不给模型 id。先用 `llm.listConfigurableProviders()` 把 namespace 映射到 provider，再 resolve 该 provider 下的模型；映射不到就全量 resolve 当前路由。

### 3.2 对齐流程

1. 取路由 `(provider, model)`：优先 `session.requestContext()`，否则最近 `request/header.config`。
2. `W_cfg ← llm.resolveModelInfo(provider, model).context?.contextWindow`。
3. `O ← header.config.maxTokens ?? resolved.defaultMaxTokens ?? 0`。
4. `B ←` 挂载的 compaction 后端配置；读不到用 65,536 并标 `assumed`。
5. 算 T，生成或复用 `epochId`。
6. `tokenMeter.measure(session)` 取分子，重算压力与各层占用。
7. 推面板，记 `alignment_latency_ms`。

任一步失败：保留上一份快照并标 `stale`，不抛错、不阻塞请求。

### 3.3 待对齐

`W_cfg ≠ W_eff` 时：

- 面板显示 `待对齐：配置 100k / 实际 200k`。
- 压力按 `min` 算，即按 100k。
- 下一次 `request/context` 落地后自动清除，并开新 epoch。

这是唯一允许同时显示两个窗口的场景。

### 3.4 失败开放

| 情况 | 行为 |
|---|---|
| resolve 超时 / 抛错 | 用 `W_eff`，标 stale |
| tokenMeter 不可用 | 显示"计量不可用"，不估算、不告警 |
| 事件丢失 | 每次 `agent/pre-step` 兜底重算一次 |
| 后端配置读不到 | 用默认 B 并标 assumed |

## 4. Shadow 采样器

### 4.1 观察点（全部只读）

| 观察点 | 用途 | 为什么不用另一个 |
|---|---|---|
| `tools/result` | 拿工具最终结果做入口试算 | 不用 `post-execute`：那会改结果 |
| `session/event` | `request/context`、`compaction/*`、轮次边界 | 事件流是唯一完整真相 |
| `agent/turn-stopping` | 轮末抽取试算 | 此时本轮已定型 |
| `agent/pre-step` | 兜底重算、发送前快照 | 只读 messages，不改 |
| `llm/adapters-updated` | 重解析 | — |

### 4.2 采样范围

- 只采样 `surfaceTokens ≥ 20k` 的会话，避免短会话噪声。
- 入口试算只对 `bytes ≥ 1400` 或 `tokens ≥ 512` 的结果做。
- 每会话最多 500 条事件，防止长会话拖垮面板。

### 4.3 反事实

影子在内存里跑一遍"如果压缩"的管线：

1. 复制节点 → 2. 入口变换 → 3. 定价 → 4. 轮末抽取 → 5. 定价 → 6. 记差值。

变换是纯函数；结果不写回、不替换、不进会话缓存。定价用 `tokenMeter.estimateMessage` 对合成消息计价。

### 4.4 七条红线

1. 不调 `tools/post-execute`，不改 `ToolExecutionResult`。
2. 不 `session.append` 任何 surface 事件，不做 replace。
3. 不调 `ctx.compaction.*`，不触发 `/compact`。
4. 不注册模型可见工具（P0 没有 `density_recall`、`density_status`）。
5. 不注入 system prompt section/context，不改工具 schema。
6. 不写会话日志（含 plugin record）。
7. 不改设置、不改其他插件配置。

违反任一条，P0 结论作废。

## 5. 指标

### 5.1 主指标

| 指标 | 定义 | 分母 |
|---|---|---|
| 净潜在节省 `R` | 每请求 surface 差值的总和 ÷ 基线输入 | `Σ totalTokens` |
| `TTC` | 会话开始到 `compaction/start` 的 surfaceTokens | 每 epoch |
| 影子 `TTC` | 影子 surface 穿过 T 时的 token（未穿过记为 ≥） | 每 epoch |
| 锚点召回 | 标注锚点被抽到的比例 | 标注集 |
| 锚点稳定 | 锚点 hash 逐轮不变的比例 | 会话 |

### 5.2 次指标与护栏

- 峰值上下文、每轮请求数、压缩事件数、原生压缩释放 token。
- 对齐延迟、stale 次数、epoch 数。
- 零改写校验失败数、影子异常数、采样丢弃数。

### 5.3 公式

```
Δ_req  = Σ_nodes tok_compressed + board_tokens + recall_tokens − Σ_nodes tok_raw
R      = Σ_req Δ_req / Σ_req totalTokens_baseline        （Δ 为负表示省）
```

`board_tokens` 与 `recall_tokens` 按"每次请求都在场"计，不用一次性口径。一个 2k 的状态板在 100 次请求里就是 200k，不乘次数会把账算成正的。

## 6. 潜在节省的反事实模型

### 6.1 三级账

| 级别 | 含义 | 用途 |
|---|---|---|
| 静态 | 单节点一次压缩的差值 | 判断方法本身是否有效 |
| 携带 | 对每次后续请求求和的差值 | 判断会话级收益 |
| 净 | 携带 − 状态板 − 召回 | 门 G1 |

携带口径是必须的：10k 的结果压到 1k，后面还有 20 次请求，省的是 180k，不是 9k。

### 6.2 顺序与去重

管线顺序：入口 → 轮末 → 状态板。

轮末卡片压在"已入口压缩"的节点上，不是原始节点。否则同一段工具输出会被算两次。

### 6.3 召回扣减

P0 没有 recall，用假设值，三臂并列：

| 臂 | 次数/轮 | token/次 | 用途 |
|---|---|---|---|
| 乐观 | 0.5 | 1024 | 下界 |
| 中位 | 1.0 | 2048 | 门 G1 |
| 悲观 | 2.0 | 4096 | 上界 |

门 G1 用中位臂；报告必须三臂齐全，只报中位视为不完整。

### 6.4 不算的情况

- never-worse 不通过（不更小、硬事实缺失、pairing 不平衡）。
- 压缩后 ≥ 原文 90%：收益不够抵风险。
- 豁免项：`density_*` 输出、当前文件读取、当前轮结果。
- tokenizer 不可用且有损方法。

## 7. 锚点 100%

### 7.1 定义

锚点 = 原始任务里"错了就全错"的部分：义务、格式、验收、路径、数字、命令、用户纠正。

### 7.2 两道检查

| 检查 | 通过条件 | 方法 |
|---|---|---|
| 抽取召回 | 100% | 100 条人工标注锚点，跨 20 个会话 |
| 逐轮稳定 | 100% | 每轮 `hash(anchorSet)` 不变 |

另报告锚点 token 占 T 的比例分布（P50/P90），用于回填定稿 §6.3 的实际比例；它只是数据，不是门。

### 7.3 为什么"100%"不能是"影子没压所以没丢"

P0 不改写，锚点当然不丢——这个 100% 是恒真的，不能当门。可证伪的定义只能是"抽取器把该抓的都抓到了"，所以 G2 落在标注集召回与逐轮稳定上。

### 7.4 原生压缩下的锚点基线（回答 §12-Q1）

`compaction-basic` 的选取范围从**第一个非 system 节点**开始，system 提示不会被影子覆盖；**首条用户消息不在保护范围内**，会进摘要。

含义：

- 原生压缩一旦触发，锚点只剩摘要里的转述；这是 P4 重注入要解决的问题。
- P0 顺带记录原生压缩前后的锚点命中率，作为风险基线，不进 G2。

## 8. 左侧栏入口（P0 唯一可见产物）

### 8.1 挂载

| 位置 | 槽位 | 注册 |
|---|---|---|
| 侧栏图标 | `sidebar.panellist` | `id: density`、`order`、`label: 密度` |
| 主面板 | `main`（keyed） | `key: density` |
| 打开 | `ctx.layout.selectPanel('density')` | 点击图标 |

### 8.2 面板信息架构

```
┌ Density · shadow ───────────── 只读 ┐
│ deepseek-v4-pro · 窗口 200k（seq 42）   │
│ 输出预留 8k · headroom 65.5k           │
│ 触发线 T 131k · epoch 1/1              │
├────────────────────────────────────────┤
│ 压力 62.1k / 131k              47%     │
│ [锚点 4.1k][工作 28k][归档 0][余量 99k] │
├────────────────────────────────────────┤
│ 潜在节省（携带）   31.4k        24.8%   │
│   入口 22.1k · 轮末 9.3k                │
│   扣减：状态板 2.1k · 召回 6.1k         │
├────────────────────────────────────────┤
│ 锚点 17 条 · 4.1k · 召回 100%           │
│ 原生压缩 0 次                          │
│ 对齐 12ms · 无待对齐                    │
└────────────────────────────────────────┘
```

### 8.3 数据通路

- Host 侧维护统一快照；`density` Remote 暴露 `snapshot(sessionId)` 与 `follow(sessionId)` 流。
- Client 面板订阅 follow；断流降级为 2s 轮询。
- 快照只含数字与标签，不含原文。

### 8.4 状态

| 状态 | 显示 |
|---|---|
| 无会话 | "打开一个会话开始测量" |
| W 未知 | "窗口未知（适配器未声明容量）"，不显示百分比 |
| 计量不可用 | "计量不可用"，不估算 |
| 待对齐 | "待对齐：配置 x / 实际 y" |
| 无原生兜底 | 角标提示（小窗口必现） |

### 8.5 不做

没有"压缩"按钮、没有"接管"开关、没有模型可见工具。P0 的面板只读。

## 9. 数据落盘

- 每会话一个 JSONL：`<metricsDir>/<sessionId>.jsonl`，默认工作区 `.density/`。
- 只存：seq、类型、字节、token、方法、是否跳过、epoch、时间。
- 不存原文；采样文本默认关闭。
- 保留 7 天或 50MB，LRU。

## 10. 运行配置（shadow preset）

| 键 | 值 | 说明 |
|---|---|---|
| `mode` | `shadow` | 固定，不可切 |
| `sampleMinSurfaceTokens` | 20000 | 低于不采 |
| `entryMinBytes` / `entryMinTokens` | 1400 / 512 | 试算阈值 |
| `turnMinTokens` | 4096 | 试算阈值 |
| `recallAssumption` | 1.0 / 2048 | 中位臂 |
| `stateBoardEstimate` | 2048 | 投影成本 |
| `maxEventsPerSession` | 500 | 上限 |
| `assumedHeadroomTokens` | 65536 | 读不到后端配置时用 |

## 11. 验收

### 11.1 G1

≥20 个真实会话，中位 `R` ≥20%；三臂 + 95% CI 齐全。

### 11.2 G2

标注集召回 100%；逐轮稳定 100%。

### 11.3 G3（零改写）

同一份会话日志分别在"加载影子"与"不加载影子"的宿主里重放，`sha256(deriveMessages())` 与 `sha256(request/header)` 必须逐字节相同。任一不同即失败。

### 11.4 G4（对齐）

测试宿主把 W 从 200k 改到 100k：

- 面板 p95 ≤500ms 更新；
- 压力立刻按 100k 算；
- 下一个 `request/context` 后 epoch +1。

100 次全部正确。

### 11.5 G5（开销）

影子 p95 增量 ≤3%；新增模型 token = 0。

## 12. 语料

| 来源 | 规模 | 用途 |
|---|---|---|
| 在线真实会话 | ≥20 个，≥20k surface | G1 主数据 |
| 离线会话日志回放 | 全量 | 批量分布 |
| 合成样本 | 表格/日志/代码/JSON 各 20 | 方法与 never-worse |
| 人工标注 | 20 会话 × 5 锚点 | G2 |

离线回放是 P0 的优势：不改写，所以历史会话可以反复跑，不需要线上流量。

## 13. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 影子 CPU 拖慢请求 | 延迟 | 采样 + 异步 + 3% 预算 |
| 反事实高估 | 门失真 | 携带口径 + 召回扣减 + 三臂 |
| W 读错 | 压力全错 | 双源 + min + 待对齐 |
| 小窗口无兜底 | 溢出 | 面板告警 + 影子提前截断 |
| 面板泄漏 | 隐私 | 只存数字与标签 |
| 原生压缩在测量期触发 | TTC 被污染 | 按 epoch 切段，记录压缩点 |

## 14. 与定稿 §12 的关系

| 开放问题 | 对 P0 的影响 |
|---|---|
| Q1 原生是否保留首条用户消息 | 已回答：不保留（§7.4） |
| Q4 状态板 system / user 角色 | 不阻塞（P0 不注入） |
| Q9 归档保留期与 purge | 不阻塞（P0 不归档） |
| 其余 7 条 | 不影响 P0 |

## 15. 交付与下一步

1. 本文件：P0 测量设计。
2. P0 实现 v0.1 已装上当前 profile（见 §16），只测量、不改写。
3. G1/G2 通过后才讨论 P1；G1 不过则停在测量层，不进入压缩实现。

## 16. 实现记录（v0.1，2026-11-04）

| 项 | 设计 | 实现 | 原因 |
|---|---|---|---|
| 指标落盘 | 工作区 `.density/` | `~/.density/shadow/<session>.jsonl` | 不污染用户工作区 |
| 面板数据 | Host Remote | `GET /density/snapshot`（2s 轮询） | 免去 typert 代码生成；P0 只要只读快照 |
| 模型可见工具 | 无 | 无（红线 4） | 保持 0 新增 token |
| `/density status` | 有 | 有（人用命令，不进上下文） | — |
| 压缩方法 | TOON/表格/日志/代码/通用 | toon / jsonl / table / log / json-shape / head-tail | 代码骨架留到 P1 |
| 锚点 | 标注集召回 | 抽取 + 逐轮 hash；标注集未标 | G2 待标注 |

首次实测（本会话，`deepseek-flash`，W = 1,048,576）：

- `O` = 256,000，`B` = 65,536 → `T = min(838,861, 727,040) = 727,040`，即 **69.3%**，不是 80%。
- surface ≈ 221k，压力 ≈ 30.5%，epoch 1。
- 入口试算：1 条 150 行日志命中 → 13 行，静态省 1,631 token；携带 1,631；扣减 8,192（2 次请求 × 4,096）→ 净额 −6,561，比率约 −1.4%。
- 结论：机制跑通，但单会话单条样本不能判定 G1；需要 ≥20 个长会话才有意义。

## 17. 首轮回放发现（2026-11-04）

对 8 个最大真实会话（`D:\DSH\home\sessions`，zstd 逐帧解码，共 9,947 步）跑离线回放：

| 口径 | 中位净节省 | 说明 |
|---|---|---|
| 只做入口预压缩 | 0.24% | 87 条命中；6,778 条工具结果 <1,400 字节 |
| 入口 + 轮末事实卡 | **22.05%** | 305 张卡；硬事实门 0 拒绝 |
| 入口 + 轮末 + 状态板（20 会话） | **21.34%**（均值 24.81%） | 579 张卡 / 727 条入口；含 v4 日志；毛账 |

三个结论：

1. **入口压缩不是杠杆。** 真实工具结果 83% 太小，1,271 条无匹配方法，823 条被硬事实门拦下。只靠入口到不了 20%。
2. **轮末抽取才是。** 但前提是卡片"由事实构建"：按行保留的做法让 305 个大轮次里 298 个被硬事实门拒绝（行抽取与事实校验口径不一致）。
3. **20% 是毛账。** 还没扣状态板（2,048/轮）与召回；且轮次替换会重置该点之后的缓存。下一步必须把这些计入，再谈净额。

另修掉一个会高估的记账 bug：轮末卡命中后没有从 entries 里移除同轮的入口节省，会造成双重计算。

## 18. 实现进度

| 阶段 | 状态 |
|---|---|
| 纯函数变换库 + 单测 | 完成（48 pass） |
| 离线回放器（zstd 逐帧） | 完成 |
| 入口/轮末 shadow 测量 | 完成（v11） |
| 归档 + `density_recall` | 完成；`write=true` 时注册 |
| 入口改写（`post-execute`） | 完成（`mode=safe/balanced` + `write`） |
| 状态板 | 完成：轮次卡携带；`compaction/end` 后重注入 |
| 轮次替换 | 完成：规划器 + 受控写入 + 子会话在线验证 |
| 原生压缩重注入 | 完成；`write` 闸控制 |
| p95 打点 | 完成：`timings.entryP95Ms` / `planP95Ms` |
| ≥20 会话回放 | 完成：中位 21.34%，均值 24.81% |
| 在线入口改写 + 召回 | 完成（§19） |
| 在线轮次替换 | 完成（§19 子会话冒烟） |
| 净账 | 完成：`overhead = 召回实际 token + 重注入 token`，不再用固定 4,096/请求的假设 |
| spillStore 双写 | 完成（best-effort；读取仍走本地归档） |

当前线上配置：`mode=balanced, write=true, surface=false` —— 入口改写与召回已开启；轮次替换已在线验证过，但为保护当前会话默认关闭。

## 19. 在线冒烟（2026-11-04）

### 19.1 入口改写 + 召回

配置：`mode=balanced, write=true, surface=false`，真实会话。

1. 生成 200 行日志（17,768 字节）→ `post-execute` 命中 `log` 方法。
2. 模型看到的工具结果变成 6 行 + 省略标记 + `[density #density-4175cf5b · 原文 17768B · 用 density_recall(marker) 取回]`。
3. 归档落盘：`~/.density/archive/<session>/4175cf5b.txt`（17,768 B）+ 同名 `.json` 边车。
4. 调用 `density_recall(marker=#density-4175cf5b, mode=head)` 逐字取回原文前 15 行，带 `nextCursor=1280` 分页。
5. 快照：`applied=1`，`entrySamples=2`，`entryP95Ms=4`。

### 19.2 轮次替换（子会话）

`surface=true` 下用一个子代理会话验证，避免动当前会话：

1. 子会话跑一轮「生成 90 行日志 → 回答 ERROR 次数」，`planCount=1`、`balanced=true`、`ratio=0.96`。
2. 快照：`appliedTurns=1`、`replaceErrors=0`。
3. 会话日志确认：`seq 37 user/message`，`surfaceOp={op:'replace',startSeq:9,endSeq:34}`，内容为 `[density card · turn 1]` + Goal/Constraints/Errors/Cmds。
4. 子会话在替换前已完成并正常回复。

验证过程中发现并修掉两个真实问题：替换范围不能覆盖 surface 节点 0 的 `system/message`（改为跳过该节点）；`append` 必须携带覆盖全部被遮蔽节点的 `sourceEventSeqs`。

### 19.3 开销（bench，300 次）

`tools/bench.mjs` 对 `post-execute` 压缩路径（含归档写盘）跑 300 次 150 行日志 / 200 行表格：

| p50 | p95 | p99 | max | mean |
|---|---|---|---|---|
| 1ms | **1ms** | 2ms | 4ms | 0.97ms |

真实会话的 `entryP95Ms` 也在 1–4ms 量级。相对秒级的请求延迟，这个开销远低于 5% 的约束。

### 19.4 替换后的信息保真（确定性代理）

子会话第一轮留下两个硬事实：命令里的 `TOKEN-XYZ-987`、禁止项「禁止读取或修改任何文件」。替换后检查卡片内容：

- `Goal` 与 `Constraints` 保留 token 与禁止项 → 下一轮可据此回答。
- 初版卡片把系统提示文字误抽成 `Cmds/Rules`（噪音），已修：`system/message`、`developer/message` 只进入替换范围，不再参与卡片文本挖掘（v15）。

子代理不支持续聊，所以没有做"第二轮真的回答"的端到端验证；这里给的是上下文保真的确定性证据，不是模型质量结论。

### 19.5 净账口径

早期版本按 `4,096 × 请求数` 扣状态板与召回，会把没有召回的会话直接压成负数。现在改成实际计费：

```
overhead = recallTokens（density_recall 输出实际 token）
         + reinjectTokens（重注入字符 / 4）
         + schemaTokens（recall 工具 schema × 注册后的请求数）
net      = carried − overhead
ratio    = net / baseline
```

- 状态板不单独计费：它只存在于轮次卡内部，卡片大小已计入 `carried`。
- `density_recall` 是**懒注册**：第一次真正压缩后才注册，注册前零 schema 成本；注册时给每个会话记下 `schemaFrom`，只对之后的请求计费。
- `spillStore` 可用时原文 best-effort 双写一份，读取仍走本地归档（spill 是 save-only）。

线上样本（v19，一次 10,568B 日志压缩后）：`static=carried=2,506`，`schemaTokens=114`，`net=+2,392`，`ratio=+0.22%`。

## 20. 工作区镜像（TXT 基线）

插件把当前上下文写成三份文件到 `mirrorDir`（当前配置为工作区的 `mirror/`）：

| 文件 | 内容 |
|---|---|
| `<session>.actual.txt` | 实际进入上下文的文本（压缩后） |
| `<session>.raw.txt` | 原文基线：含 marker 的结果用归档逐字还原 |
| `<session>.tokens.json` | `{actualTokens, rawTokens, savedTokens, ratio}` |

触发方式：每轮开始自动重建；`GET /density/mirror` 或 `/density mirror` 可强制重建。

线上样本（v21）：980 条消息，`actual=219,704` / `raw=253,113` token，省 **33,409（13.2%）**。

注意口径：这是"当前上下文"的快照对比，不是累计消耗；累计成本看面板的 `carried / baseline`。轮次替换的卡片内容也会进入 actual，而 raw 只还原工具结果——两者差异正是入口压缩的可见效果。









