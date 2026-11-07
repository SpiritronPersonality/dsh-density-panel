# Density Compact V1 · 验收报告

> 日期：2026-11-04
> 范围：`@local/density-panel` v19，profile `desktop`
> 结论：**功能闭环达成**。五条功能全部实现并有自动化测试；入口改写、召回、轮次替换在真实会话验证；原生压缩重注入由集成测试覆盖，未在线触发（见 §5）。

## 1. 交付物

| 交付物 | 位置 |
|---|---|
| 设计定稿 | [DENSITY-DESIGN.md](DENSITY-DESIGN.md) |
| P0 测量设计 + 实现记录 | [DENSITY-P0-SHADOW.md](DENSITY-P0-SHADOW.md) |
| 插件源码 | [plugin/density-panel/](plugin/density-panel/) |
| 变换库 | [lib/transform.js](plugin/density-panel/lib/transform.js) |
| 归档 | [lib/archive.js](plugin/density-panel/lib/archive.js) |
| 状态板 | [lib/stateboard.js](plugin/density-panel/lib/stateboard.js) |
| 轮次规划 | [lib/turnplan.js](plugin/density-panel/lib/turnplan.js) |
| 测试 | [test/](plugin/density-panel/test/)（55 条） |
| 离线回放 | [tools/replay.mjs](plugin/density-panel/tools/replay.mjs) |
| 开销基准 | [tools/bench.mjs](plugin/density-panel/tools/bench.mjs) |

## 2. 功能验收

| 条款 | 状态 | 证据 |
|---|---|---|
| 入口预压缩（never-worse + spill + marker） | 完成 | `tools/post-execute` 改写；四道门（尺寸/方法/硬事实/≥10% 收益）；原文 0600 归档 + `spillStore` best-effort 双写；marker 回填结果尾部。线上：10,568B 日志 → 6 行 + `#density-d2156d01` |
| 轮次抽取卡 | 完成 | `buildCard` 由事实构建；子会话在线替换成功：`appliedTurns=1`、`replaceErrors=0`、日志 `{op:'replace',startSeq:9,endSeq:34}` |
| 状态板注入 | 完成 | 首条用户消息种下 goal/constraints；每轮并入 paths/errors/open/decisions；卡片携带 board（384 token 上限） |
| 归档 + `density_recall` | 完成 | 懒注册（压缩前零 schema 成本）；marker 分页取回、query 检索；线上逐字取回 13,268B 原文 |
| 原生压缩后重注入 | 完成（未在线触发） | `compaction/end` → append 锚点原文 + board；集成测试验证 append 形状与内容 |

## 3. 硬约束验收

| 约束 | 结果 | 证据 |
|---|---|---|
| 锚点 100% 不丢 | 通过 | 锚点原文不入压缩；轮次替换从 surface 节点 0 之后开始（首条用户消息在 turn 外）；重注入用逐字 `anchorText`；`anchorHash` 逐轮稳定 |
| tool pairing 0 错 | 通过 | 规划器 `checkPairing` 要求 call/result 一一对应；范围与 live surface 逐节点校验；子会话替换 `replaceErrors=0` |
| p95 开销 ≤5% | 通过 | bench 300 次：p50/p95/p99 = 1/1/1ms，max 3ms；线上真实步延迟中位 3,531ms、p95 15,925ms（330 步）→ 开销约 0.03% |
| never-worse | 通过 | 压缩后必须更小且过硬事实门，否则 `next()` 原样放行；轮次卡要求节省率 ≥25% 且 <原文 90% |
| 失败开放 | 通过 | 所有事件回调 try/catch；`post-execute` 失败走 `next()`；replace/reinject 异常只计数不抛出 |
| 不改写稳定前缀 | 通过 | 入口改写发生在首次发送前；轮次替换跳过节点 0；重注入用 append |
| 净 token 不增加 | 通过（有前提） | 净账 = carried − 召回 − 重注入 − schema×注册后请求；线上样本 net +2,392。前提：至少发生一次压缩，否则 schema 成本为 0 且也无节省 |

## 4. 测试与回放

- 单测/集成：**55 pass / 0 fail**（变换 18、宿主/集成 19、归档 6、状态板 5、轮次规划 7）。
- 离线回放：20 个真实会话，中位毛节省 **21.34%**、均值 24.81%（579 张卡 / 727 条入口）。
- 开销：p95 1ms（见上）。

## 5. 残留限制（诚实披露）

1. **原生压缩重注入未在线触发**：本会话窗口 1,048,576、触发线 727,040，未到阈值。仅由集成测试覆盖，没有真实 compaction 事件下的线上证据。
2. **质量未做 A/B**：没有任务通过率基准。卡片是事实抽取，语义细节可能丢失；目前只证明了 token 指标与上下文保真（token/禁止项在卡片中保留）。
3. **回放是毛账**：未计轮次替换的缓存重置成本；召回成本按实际调用计，但回放里默认不召回。
4. **归档用本地存储**：`spillStore` 是 save-only，无法取回；因此读取走 `~/.density/archive`，仅 best-effort 双写。

## 6. 关闭与回滚

| 目的 | 操作 |
|---|---|
| 停止改写 | `cordis.patch.yml` 设 `write: false`，重装 bundle |
| 停止轮次替换 | `surface: false` |
| 完全卸载 | `plugin_manager remove_bundle @local/density-panel` |
| 清理归档 | 删除 `~/.density/archive` 与 `~/.density/shadow` |

## 7. 变更记录

- 2026-11-04 · 镜像产物处置：删除 `mirror/` 下 66fe547c 会话的两个 txt（1.96MB），仅保留 `tokens.json` 指标；当前会话样本移到 `~/.density/mirror`；`cordis.patch.yml` 去掉 `mirrorDir`，回落到默认 `~/.density/mirror`（下次启动 DSH 生效）。镜像不进上下文（`workspace/changes` 事件计数为 0），成本仅为磁盘。
- 2026-11-04 · 测试以逐文件直跑复核：**57 pass / 0 fail**（比 §4 的 55 条多 2 条，新增镜像测试）。`node --test` 的 runner 在沙箱下 spawn EPERM，不代表测试失败。
- 2026-11-07 · 上线 2 天实测：11 个会话、2,873 条消息、895,852 token 文本，实际只省 **24,156 token（2.70%）**；入口压缩仅触发 17 次，5/11 会话一次未中。根因不是门限，而是**硬事实门**：抽样丢掉路径/错误后整条被否，抽样会话里 55 条大输出有 28 条因此被拒。
- 2026-11-07 · B 版改造（v22）：入口门限 1,400→**600 字符** / 512→**150 token**；新增 `diffContext`（补丁去未变更上下文）与 `withHardFacts`（抽样丢掉的事实回填成一行，保证 `hardFactsPreserved` 通过）；JSON 数组/JSONL/表格/日志/头尾下限同步下调；`write` 模式下 `toolSeen`/`skip*` 计数器恢复（原来在 `tools/result` 里被 `if (writeEnabled) return` 挡掉，恒为 0）。
- 2026-11-07 · 离线重放同一批 13 个真实会话（2,071 条工具结果）：旧代码 7 条 / 30,798 token → B1（新算法+事实回填、旧门限）313 条 / 533,192 token → B2（再加新门限）**394 条 / 552,462 token**。增量主要来自事实回填，门限只贡献 +22k。测试 **63 pass / 0 fail**。风险：单条压缩比约 82%，质量未做 A/B；`density_recall` 至今未被调用过。
- 2026-11-07 · 真实语料测试（v23，报告见 [DENSITY-TEST-REPORT.md](DENSITY-TEST-REPORT.md)）：《红楼梦》20 万字符与 Linux `sched/core.c` 20 万字符，压缩后分别保留 **2.12% / 0.71%**，中段细节 **0/24 存活**，判决 `pointer-only`。同时修掉两个真问题：`compressText` 把 options 当行数导致头部为空、省略计数 `NaN`、表格丢表头；`log` 采样被散文/源码误命中（加形态门：≥30% 行像日志才用）。在线会话验证：`toolSeen=26` 中 7 条实际压缩，静态省 6,109、净 +78,181，召回 2 次 729 token 均逐字取回。测试 **67 pass / 0 fail**。
- 2026-11-07 · P1+P2（v24）：新增 `codeOutline`（保留 `#include`/`struct`/`class`/列 0 函数签名，丢函数体；上限为行数 25% 且 ≥300 行），`headTail` 增加散文守卫（CJK 占比 ≥35% 且非代码 → 不压）。同一语料复测：**《红楼梦》直接跳过压缩（100% 保留）；内核源码 `code-outline` 保留 14.9%，函数定义存活 24/24**，判决 `structure-preserving`。测试 **69 pass / 0 fail**。代价：中文长散文零节省（刻意）；代码函数体需召回。
- 2026-11-07 · v25：真实链路修复。v24 离线全绿但线上读内核源码仍走 `headtail`——`read` 工具每行带 `3000: ` 行号前缀，代码特征被打断。新增 `stripGutter`（分类前剥离行号，输出保留），同一段 400 行代码从 `headtail` 变为 `code-outline`（保留 10.5%，定义 9/9）。线上实测散文读（红楼梦 120 行）**未被压缩**，P2 生效。测试 **70 pass / 0 fail**。
- 2026-11-07 · v26：打磨两处误判——`struct/class/enum` 等声明锚定列 0（不再保留函数内局部变量行）；路径事实正则排除 `/*`、`//` 开头（此前每段代码压缩都会多一行 `[硬事实 1 条] /*`）。同一段代码保留率 10.5%→**7.0%**，伪事实归零。测试 **72 pass / 0 fail**。
- 2026-11-07 · P5 真实价值 A/B（报告见 [DENSITY-P5-REPORT.md](DENSITY-P5-REPORT.md)）：5 份真实文档 × 28 道单选题 × 2 组盲测、机械判分。**原文 27/28（96.4%）→ 压缩 19/28（67.9%）**；压缩组 9 次失败**全部是回答"文中没有"**，无错误猜测，答了的题 19/19 全对；输入 token 11,564→3,940（-66%）。分类型：JSON 5→5、代码 6→5、日志 6→4、表格 **6→1**、散文对照 4→4。结论：JSON/代码可放心压，**表格行抽样必须关**，日志需补聚合统计行。
- 2026-11-07 · v27 质量优先（`policy: quality`，默认）：按 P5 结论收紧管线——只保留**保值**（JSON/JSONL→CSV）与**保结构**（代码大纲、diff）的变换；`tableSample`、`headTail`、`jsonObjectShape` 在 quality 下**默认不启用**（`policy: aggressive` 可恢复旧行为）。`logSample` 增加一行聚合统计 `[统计] INFO=155 ERROR=5 status500=5`，把"数数"类问题从不可答变可答。测试 **79 pass / 0 fail**。
- 2026-11-07 · v27 窗口账本：新增 `lib/ledger.js`，按 **上下文窗口**（epoch = provider/model/窗口/触发线）逐窗口记账，落盘 `~/.density/windows/<会话>.jsonl`，记录 requests、入口条数与节省、轮次卡、召回次数与 token、原生压缩次数、压力峰值、策略与是否关闭。窗口切换时写终态，轮次结束与每 15 秒写快照；**重启后仍在**，快照 API 暴露 `window`（当前）与 `windows`（最近 8 个）。面板新增「窗口账本」卡。
- 2026-11-07 · v28：真实链路修复（与 v25 同源）。`read` 的 `N: ` 行号前缀会让日志形态门失配（`logSample` 直接拒绝），也让 `JSON.parse` 失败（`toon` 接不到）。新增 `ungutter`（≥80% 行带前缀时先剥离）用于 JSON 数组/JSONL/表格，`logShaped` 判定前同样剥离。线上验证：读 160 行日志 → `log` 压缩（13,186B → ~2.1KB，含 `[统计] INFO=155 ERROR=5 status500=5`），`toolSeen=1 / noMethod=0 / entries=1 / saved=2,805`。测试 **81 pass / 0 fail**。
- 2026-11-07 · v29 记忆白名单：`cairn_*` 与 `density_recall` 的工具输出**永不压缩**，直接放行，新增 `skipProtected` 计数（快照 debug 可见），`protectedTools` 可通过配置扩展。理由：记忆是上下文里唯一的一份，被抽样后与"错的记忆"无法区分；省它的 token 没有意义。测试 **82 pass / 0 fail**。
- 2026-11-07 · v30 代码默认不压：`quality` 策略移除 `code-outline`（仅 `policy: aggressive` 可用）。依据是 16 个会话 59 次压缩的实测：`code-outline` **召回率 58%**（19 次里 11 次被召回），按体积分桶净收益为 `<2k: +2,347`、`2–4k: +12,414`、`4–8k: −881`——只有中等文件小幅赚钱，大文件净亏，小文件白忙。代码审查要的是函数体，摘要式压缩是用途错配。整体代价约 1.4 万 token / 7 天，换“读源码永远完整、少一次召回往返”。测试 **82 pass / 0 fail**。
- 2026-11-07 · v31 **会话损坏事故修复**：一个代码审查会话加载失败，报 `session event at seq 4585 lacks an identified message`。根因是插件的 “原生压缩后重注入”用 `session.append` 写入 user/message 时**没有 `data.id`**，DSH 校验直接判定会话损坏。全库扫描仅 1 条（该事件），无其他会话受影响（历史上只有它会触发重注入）。已用 `tools/repair-session-id.mjs` 补 uuid 修好日志（原件备份为 `.bak-2026-11-07T14-53-36-272Z`，校验：5303 事件、seq 单调、0 条缺 id）。代码 v31：重注入与轮次替换两处 append 都加 `randomUUID()`，测试断言 message 必须带 id。**82 pass / 0 fail**。
- 2026-11-07 · 版本对齐：插件页显示的是 `package.json` 的 `version`，与运行时内部常量 `VERSION` 长期不同步（页面 0.1.0 / 运行 31）。现约定 **minor 号 = VERSION**，`package.json` 升到 `0.31.0`，并新增测试断言 `package.json` 的 minor 必须等于 `VERSION`，防止再次漂移。同时修掉两处陈旧信息：描述仍写“只读观测、绝不改写”（实际会压缩），中英文描述改为实际行为；`locale/zh.json` 再次出现双重编码乱码，已重写；面板页脚从写死的“面板 v2”改为读取快照里的运行时版本。测试 **83 pass / 0 fail**。
