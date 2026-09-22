# 语义文档：上下文治理与两条提醒通道（Context Governance & Reminders）

> 版本 v0.2.3 · 2026-09-22（最近复核）· 作者：爱丽丝 · 状态：**已实现**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-context/src/{index,compaction-watch,inflight-gate,pruner,prune-plan,reminder-state,format}.ts`
> 语义主副本：本文；压缩事务侧契约见 `self-plugins/dsh-agent-compact/docs/semantic.md`（互相指认）

---

## 1 · 定位与反定位

**定位**：上下文治理一体化插件——① `/context` 命令 + `ctx.contextMeter` 服务（结构化占用快照）② 剪枝工具族（`prune_candidates` / `prune_apply` / `expand` / `prune_guard` / `prune_stats` + 入口守卫折叠）③ **两条提醒通道**：【上下文提醒】（越档/越阈值建议压缩）与【压缩告警】（上一次压缩失败）。

**反定位（本文不管什么）**：
- 不管压缩事务与捕获（→ `dsh-agent-compact`）
- 不管压缩入口/授权/直触（→ `dsh-compact-provider`）
- 不管**压缩提醒**（「压缩前建议先炼化」→ `dsh-agent-skill-forge`）——**两者不是一个东西**：上下文提醒讲占用，压缩提醒讲炼化时机
- **不是**自动执行器：本插件只**送达信号**，压缩与否由爱丽丝裁决（§2.1）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 提醒（reminder） | 由插件投递到会话的 user 消息（source.plugin 标明出处），只告知、不执行 |
| 上下文提醒 | **两条子通道共用同一投递口**（`interject`，2026-09-22 起「要走插话形式」）：① **梯级插话**（主）：`【上下文提醒】上下文已用 N%（约 Xk / Yk）——已跨过 N% 档。建议压缩…` ② **绝对阈值**（旧，`contextWindow` 拿不到时兜底）：`【上下文提醒】当前上下文约 Nk tokens（阈值 Mk）——建议及时压缩…` |
| 梯级插话 | 按用量**百分比档位**（`warnAtPercents`，默认 50/65/80/90）递进投递的上下文提醒；跨档即插、**每档只插一次**（去重落盘 `warnedStepByAgent`） |
| 压缩在飞闸门 | 梯级评估**之前**先问「`compaction/start` 是否未配对」；在飞 ⇒ **本轮不评估**（此刻的读数即将被压缩作废），带自愈预算（默认 180s） |
| 重新武装（re-arm） | 压缩**成功**（`compaction/end` 无 `error`）后清掉已报档位，使梯级从最低档重来（按 end seq 去重落盘 `rearmSeqByAgent`） |
| 压缩告警 | `【压缩告警】上一次压缩**失败**，上下文没有缩小——<error>（compaction/end seq=N）` |
| 在飞行（inFlight） | 最近一次 `compaction/start` 晚于最近一次 `compaction/end`（结论未定） |
| 结局（outcome） | 最近一次 `compaction/end`：带 `error` = 失败，否则成功 |
| 投递前重验 | send 之前重读判据（关联 seq 是否仍是最近结论），不一致即作废 |
| 入口守卫 | 大工具结果在进上下文前折叠为「头 + 折叠标记 + 尾」（源头控制） |

## 3 · 概念模型

```
session/event(turn/end)  ← 每轮必发，不依赖状态转换（§5.12）
   ├─ 通道 1【上下文提醒】:
   │      ① 压缩在飞闸门：watchCompaction().inFlight ⇒ 本轮**不评估**（读数会被压缩作废；实测差 1.96s）
   │      ② 压缩成功后**重新武装**：endSeq 未处理且最近一次 end 无 error ⇒ 清 warnedStep（按 seq 去重落盘）
   │      ③ 梯级：nextWarnStep(warnAtPercents, projectedTokens, contextWindow, 已报最高档)
   │           跨档 ⇒ **先落盘**（withWarnedStep + withWarned）→ setImmediate → agent.send(text, 'next-step', true)
   │      ④ 旧通道（窗口拿不到时兜底）：≥ warnThreshold + 冷却（shouldWarn）
   └─ 通道 2【压缩告警】: 读事件流 watchCompaction(read, seq)
          ├─ inFlight=true  → 不播报（结论未定）
          ├─ failure=null   → 清除已提醒 seq（健康）
          └─ failure≠null   → 去重（按 failure.seq）→ setImmediate →
                 send 前**重验**：latestSeq 仍是同一 failure.seq 才发，否则作废（交给下一轮按新结论播报）

工具面: prune_candidates / prune_apply / expand / prune_guard / prune_stats（+ /context 命令、ctx.contextMeter 服务）
```

不变量（invariants）：
1. **I1 只送达不裁决**：提醒不触发任何压缩动作（§2.1「机制把信号送达，不代替决策」）
2. **I2 触发时机用「每轮必发」事件**：`turn/end`，不依赖 `agent/status` 状态转换（§5.12 §1）
3. **I3 投递前重验**：读时结论 ≠ 投递时结论；send 之前重读，关联 `seq` 不再匹配即作废（§5.12 §5）
4. **I4 飞行中不播报**：事务未落定时一律不报「上一次失败」
5. **I5 reenter 纪律**：事件回调内不直接 `agent.send`，一律 `setImmediate` 延迟（§5.12 §4）
6. **I6 失败静默但不阻塞**：提醒通道任何异常都吞掉并 return——绝不影响会话与压缩本身（代价：只能靠日志/留痕反推，见 U3）
7. **I7 剪枝只碰 tool/result 节点且 replay-safe**：只追加日志 + 定价事件，可回放恢复
8. **I8 读数有时刻（在飞即不评估）**：通道 1 的数（`projectedTokens` = 下次请求预计大小）在**压缩落地前**算、**落地后**才投递（实测差 1.96s）⇒ 事务在飞时**不评估**。与 I3 的分工按**形状**定：读数被事件作废 ⇒ 闸门加在「算之前」（作废源 `compaction/start` 早于读数就在事件流里）；结论被后来的结论取代 ⇒ 投递前重验。**两者不对称是刻意的，不是遗漏**
9. **I9 跳过必须自愈**：在飞抑制带预算（默认 180s > 压缩自身 120s 总结超时），超预算视为**僵尸事务**（未配对的 start）⇒ **放行**——否则一条僵尸 start 会把通道永久静音（§5.10 / §5.17）
10. **I10 压缩后重新武装**：压缩让用量**合法回落** ⇒ 清已报档位（否则压缩一次自废 30 个点灵敏度）。按 `compaction/end` seq 去重**并落盘**（否则每个 turn/end 都清 = 梯级永不生效）；**失败结束不清**（上下文没缩小）

## 4 · 契约

### 4.1 服务 / 命令 / 工具
- 服务：`ctx.contextMeter`（`ContextMeter extends Service`，`report(session) → ContextReport`：占用/构成/健康）
- 命令：`/context`（无参数；打印占用与花费）
- 工具：`prune_candidates`（只读候选 + 剪后缓存代价；**2026-09-20 起**每个候选另带 `flags` 内容指纹 / `levels` 三档字符账 / `suggest` 建议档位）、`prune_apply`（按 seq 剪；**`level` 参数** = `L1-head-tail`（缺省，等价旧行为）/ `L2-heavy` / `L3-note-only`）、`expand`（按 callId 豁免折叠）、`prune_guard`（入口守卫开关/状态）、`prune_stats`（剪枝统计 + 缓存命中率）
- 配置：`warnThreshold`(500000) / `warnCooldownMs`(3600000) / **`warnAtPercents`(`[50,65,80,90]`，2026-09-22 新增：梯级档位，升序；**空数组 = 关掉梯级只剩旧通道**；拿得到 `contextWindow` 时按它递进，拿不到则自动退回旧通道）** / `pruner{thresholdChars,headChars,tailChars,guardEnabled,guardThresholdChars,guardHeadChars,guardTailChars}`。⚠ 2026-09-22 复核：`pruner.headChars/tailChars` 自 2026-09-20 起**不再参与 `prune_apply` 的预算**（改由 `PRUNE_LEVELS[level]` 决定，`src/pruner.ts:405`）；两者缺省值恰与 L1 相同（4096/1024）故缺省行为不变，但**非默认配置值会被静默忽略** —— 已登记 §10 U4

### 4.2 裁决（纯函数优先）
- `watchCompaction(read, fromSeq, lookback=400) → {failure, endSeq, inFlight}`：一次扫描同时给「最近已结束的结论」与「是否在飞行」
- `latestCompactionFailure(read, fromSeq, lookback) → {seq, error}|null`：`watchCompaction().failure` 的薄包装（语义：最近一次已结束的压缩失败才算失败；旧错误不报）
- **梯级与闸门（`src/reminder-state.ts` + `src/inflight-gate.ts`，纯函数，2026-09-22）**：
  - `nextWarnStep(percents, usedTokens, contextWindow, lastStep) → {step, percent}|null`：跨档裁决；窗口未知/占用量非法/档位为空 ⇒ `null`（退回旧通道，不瞎报）
  - `withWarnedStep(state, agentId, step)`：记已报最高档（**只升不降**，回退是 no-op）；`withoutWarnedStep(state, agentId)`：清档（重新武装用；无记录返回**原对象**）
  - `shouldRearm(state, agentId, endSeq)` / `withRearmed(state, agentId, endSeq)`：按 `compaction/end` seq 去重，只升不降
  - `gateLadder(gate, agentId, inFlight, nowMs, graceMs=180_000) → {gate, suppressed}`：在飞即抑制；不在飞则清计龄（无记录返回原对象，零 churn）；超预算放行（僵尸识别，见 I9）；计龄只用**本进程墙钟**，不读事件时间字段（不猜其单位语义）
  - 全部状态落在 `<DSH_HOME>/context-reminder-state.json`（单行 JSON，人读友好；坏数据一律回落空状态）
- **剪枝档位（`src/prune-plan.ts`，纯函数，2026-09-20 移植自 `tamaratran/fast-jev-compaction`）**：
  - `PRUNE_LEVELS`：L1 = 头 4096 + 尾 1024（= 插件旧默认，向后兼容锚点）· L2 = 头 1024 + 尾 256 · L3 = 头尾皆 0（只留一行注记，注记开销 `NOTE_OVERHEAD_CHARS`）
  - `inspectContent(text) → ContentFlags`：内容指纹（`error` / `paths` / `unique-ids` / `commands` / `homogeneous` + `irreplaceable`）——「**重跑工具能否替代**」的**启发式代理**，不是语义判断本身
  - `suggestLevel(flags) → PruneLevel`：不可重取信号 ⇒ L1；同质大块 ⇒ L3；其余 ⇒ L2
  - `planLevels(totalChars) → LevelPlan[]`：三档各自的 `charsAfter` / `savedChars` / `effective`（字符账可见）
  - 语义边界：**只给账目与信号，剪不剪、剪哪档仍归爱丽丝**——与 I1 同源（机制把信号送达，不代替决策）

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| 宿主事件 | `src/index.ts` `ctx.on('session/event')` ×2 | 通道 1（上下文提醒）与通道 2（压缩告警守望），均只在 `turn/end` |
| 宿主事件 | `src/index.ts` `ctx.on('session/event')`（pruner） | 大工具结果进上下文前折叠（入口守卫） |
| 纯模块 | `src/inflight-gate.ts` `gateLadder`（由通道 1 在**量之前**调用） | 梯级评估前（见 I8） |
| 命令面 | `src/index.ts` `ctx.commands.register({name:'context'})` | 手动体检 |
| 工具面 | `src/index.ts` → `applyPruner(ctx, cfg)` | 5 个剪枝工具 + 守卫 |

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：本插件防「上下文无声爆掉 + 压缩失败无声」，不防恶意调用，也不做鉴权
- 不越界清单：不触发压缩、不改写会话内容、不删事件（剪枝是表层折叠 + 日志保留）
- 失败面：① 提醒读失败/发送失败 → 静默 return（**代价**：只能靠日志与事件流反推；见 U3）② 剪枝写失败 → 报错不静默（工具面返回错误）③ 守卫开关读失败 → 保持现状（不静默改状态）

## 6 · 与既有机制的关系

- AGENTS.md **§5.12**（提醒机制防静默失效，含 §5 投递前重验）——本插件是这条规则的落点
- AGENTS.md **§5.10 §3**（静默失败 = 死亡温床）、**§5.17**（跳过分支必须自愈，I9 的出处）、**§5.18**（投递纪律：落到「我在的会话」）
- AGENTS.md **§2.1/§2.4**：提醒 ≠ 自动决策
- 与压缩链的关系：本插件**只观测**压缩事件流（`compaction/start|end`），不写压缩事件

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据 | 状态 |
|---|-----------|------|------|
| A1 | 占用 ≥ `warnThreshold` → 投递【上下文提醒】（含数字） | 真实消息 `约 566k tokens（阈值 500k）` | 已实测 |
| A2 | 冷却窗口内不重复投递 | 单测/配置 + 事件流无重复 | 已实测 |
| A3 | 最近一次压缩成功 → 不报旧失败 | 单测（`不误报：最近一次 compaction/end 无错 → null`） | 已实测（单测） |
| A4 | 飞行中（start 晚于最近 end）→ 不播报 | 单测（`飞行中：… inFlight=true`） | 已实测（单测） |
| A5 | 投递前重验：飞行的那次已成功落定 → 告警作废 | 单测（`投递前重验：… failure 变 null`） | 已实测（单测） |
| A6 | 好样本不误报：窗口内无压缩记录 / 空 error / 非字符串 error | 单测各一例 | 已实测（单测） |
| A7 | 有界回溯：超 `lookback` 的旧失败不报 | 单测（`有界回溯`） | 已实测（单测） |
| A8 | 真实假告警事故不再复现（8102/8103 入队 → 8114/8115 迟到 → 内容过期） | 事件流 + 0.2.2 部署后无同类 | 已实测（修前复现、修后无） |
| A9 | 剪枝可回放：剪后能从日志重建原文 | `prune_stats` + 日志 | 已实测（历史） |
| A10 | `tests/format.test.ts` 参与回归 | `npm test` 只跑 `tests/*.test.mjs` ⇒ **该 .ts 未被执行** | **未验证（明确标注）** |
| A11 | 重启后同一失败 seq 不再播报（事故 9088） | 单测 `同一失败 seq 跨重启不再重复播报（事故 9088）` | 已实测（单测） |
| A12 | 三档字符账**单调**（L1 最保守 → L3 最激进）且 L1 预算 = 插件旧默认 4096+1024 | `tests/prune-plan.test.mjs`：`省下的字符逐档递增` · `L1 预算 = 4096+1024（与插件旧默认一致 —— 向后兼容的锚点）` | 已实测（**2026-09-22 复跑**：`node --test tests/prune-plan.test.mjs` → 11/11 绿） |
| A13 | 内容指纹能读出「重跑工具能否替代」的代理信号（报错栈 / 唯一 ID / 非大块路径 ⇒ 不可重取；同质大块 ⇒ 可激进） | `tests/prune-plan.test.mjs` 的 `inspectContent` 6 例（含正反例与干净短文） | 已实测（同上，11/11）；⚠ 该 11 例覆盖 `inspectContent`(6) + `planLevels`(5)，**不含** `suggestLevel` 与「档位 → 实际剪枝结果」链路（见 §8） |
| A14 | 压缩在飞 ⇒ 梯级**不评估**（防投递已作废读数） | `tests/inflight-gate.test.mjs`：尸体样本用**实测时刻本身**（t=1790069102312 读 651K/65%）+ 连续在飞仍抑制 | 已实测（单测）；⚠ **线上待验收**：下一次真实压缩时不应再出现「已跨过 N% 档」的假插话（2026-09-22 17:25 那次即本缺陷现场） |
| A15 | 僵尸事务（未配对 `compaction/start` 超预算）⇒ **放行**，不永久静音 | `tests/inflight-gate.test.mjs` 对照组：`超预算 ⇒ 视为僵尸，放行` + `预算常量必须长于压缩自身 120s 总结超时` | 已实测（单测，含对照组） |
| A16 | 压缩成功后**重新武装**（清档 + 按 end seq 去重） | 单测 3 例（含反证「不清档 ⇒ 51% 沉默」）+ **线上落盘实证**：2026-09-22 17:40 读 `<DSH_HOME>/context-reminder-state.json` → `"warnedStepByAgent":{}` 且 `"rearmSeqByAgent":{"session-005ddf46…":22054}` | **已实测（线上）** |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（两提醒通道 + 命令 + contextMeter）、`src/compaction-watch.ts`（纯判定）、`src/inflight-gate.ts`（纯判定：在飞抑制闸门）、`src/pruner.ts`（剪枝 + 入口守卫）、`src/prune-plan.ts`（纯函数：档位预算 / 三档字符账 / 内容指纹）、`src/reminder-state.ts`（提醒状态持久化的纯函数）、`src/format.ts`（报告格式化）
- 同语义副本：无；压缩事务侧（消费方）见 `dsh-agent-compact/docs/semantic.md`
- 未实现/未验证部分**显式标注**（2026-09-22 复核修正 ②⑥）：① A10（`format.test.ts` 未被 test 脚本收集）② 提醒通道的**落盘存活证据**：`<DSH_HOME>/context-reminder-state.json` 持久化四个字段——`failureSeqByAgent`（失败去重 seq）/ `warnedAtByAgent`（上下文提醒的最后投递时刻）/ `warnedStepByAgent`（梯级**已报最高档**，2026-09-22 增）/ `rearmSeqByAgent`（重新武装去重 seq，2026-09-22 增）；**线上落盘实证**：该文件 2026-09-22 17:40 实测内容为 `{"failureSeqByAgent":{},"warnedAtByAgent":{…4 会话…},"warnedStepByAgent":{},"rearmSeqByAgent":{"session-005ddf46…":22054}}`。**仍未落盘**：投递**计数**（`notifiedCount`）与**压缩告警**的投递时刻（见 §10 U3）③ 提醒文本未做长度上限（超长上下文数字正常，但无截断保护）④ **`suggestLevel` 与「档位 → 实际剪枝结果」链路无单测**：`tests/prune-plan.test.mjs` 11 例只覆盖纯层 `inspectContent`(6) + `planLevels`(5)，`prune_apply` 的 `level` 装配（`src/pruner.ts:405`）与 `suggestLevel` 只经线上工具面在用、**未验收** ⑤ `pruner.headChars/tailChars` 自 2026-09-20 起为**死字段**（见 §10 U4）⑥ **「在飞抑制」无独立侧车计数**（2026-09-22 刻意取舍）：它的证据住在**权威源**里——事件流有无未配对的 `compaction/start`——再记一份等于造第二个真源。若它误抑制，症状是「没插话」，**可与「用量未跨档」区分**：查事件流即可定性（无需为它增设计数器）
- ⚠ 测试覆盖面：`npm test` = `tests/*.test.mjs`（format 之外四个文件）；本插件单测 **48 例**（2026-09-22 复跑 48/48 绿）

## 9 · 实践修订记录

- **2026-09-05 首次实践（提醒静默失效）**
  - 语义**被修正**：触发时机从状态转换改为「每轮必发」的 `turn/end`；阈值状态区分「首次初始化 vs 沿用已有」
  - 教训：逻辑在跑但条件永不满足 = 静默失效，必须带存活证据
- **2026-09-11 二次实践（压缩失败守望）**
  - 语义**被补充**：新增通道 2——读 `compaction/end.error` 并浮出水面（根因：引擎忙路径 fire-and-forget，错误回不到调用方；10 次压缩失败跨 2 天无人知晓）
- **2026-09-14 三次实践（假告警 · v0.2.2）**
  - 语义**被补充**：**读时结论 ≠ 投递时结论**——读点（turn/end）最近一次已结束的压缩是失败、且新一轮正在飞行；投递点飞行的那次已成功（事件流 8092 start → 8108 end 无错）⇒ 主人收到**已过期**的失败告警
  - 语义**被修正**：`latestCompactionFailure` 之上加 `watchCompaction`（暴露 `inFlight`）→ ① 飞行中不播报 ② send 前重验关联 seq
  - 教训：判据与处置分开；「读到的结论」在延迟投递路径上必须有保鲜机制
- **2026-09-14 四次实践（重启即失忆 · v0.2.3）**
  - 语义**被补充**：两条通道的去重/冷却原本**只在内存**（`warnedAt` / `notifiedFailureSeq` 两个 Map）⇒ 每次 web 重启把**同一笔旧失败**再播报一次（实测 `compaction/end` seq=9088 的告警在 09:32:45 重启后重复投递 = 狼来了），冷却也归零。这是 §5.12 §3「提醒类机制要有存活证据」的**镜像条款**：那条治「该报没报」，这条治「报过的又报」——同根 = **状态只在内存 = 重启即失忆**。
  - 语义**被补充**：新增 `src/reminder-state.ts`（纯函数）与 `<DSH_HOME>/context-reminder-state.json`；**投递前先落盘**（顺序与「至多一次」同款）；fail-safe 方向 = 坏数据回落空状态。
  - 新增可证伪验收（A11）：**重启后同一失败 seq 不再播报**——单测「同一失败 seq 跨重启不再重复播报（事故 9088）」；线上验收 = 下一次重启后不再出现 9088 那条告警（本次部署时已把 9088 预写进状态文件，避免新代码首轮再喊一次）。
- **2026-09-22 复核回写（由 `semantic_check` 的 D3「实现比文档新」触发；触发源 `src/pruner.ts` mtime）**
  - 语义**被补充（文档滞后于实现）**：2026-09-20 移植 `fast-jev-compaction` 的**渐进降级**落到剪枝面——`prune_candidates` 每个候选新增 `flags`（内容指纹）/ `levels`（三档字符账）/ `suggest`（建议档位），`prune_apply` 新增 `level` 参数（缺省 L1 = 旧行为）。原文 §4.1 的工具契约与 §8 实现清单**都还是 09-14 的旧样子**（只在 `prune_candidates` 写「只读候选 + 剪后缓存代价」）。已回写 §4.1 / §4.2 / §8，并补验收 A12/A13。
  - 判据**被加强**：A12/A13 的证据是**我复跑的**离线单测（`node --test tests/prune-plan.test.mjs` → 11/11 绿、`tests/reminder-state.test.mjs` → 7/7 绿），不是「实现声称如此」。同时**如实标注没覆盖的部分**：`suggestLevel` 与 `prune_apply` 的 level 装配无单测（§8 ④）——**已实现 ≠ 已验收**。
  - 语义**被修正（文档与自己的上一次修订矛盾）**：§8 ② 与 §10 U3 写「提醒通道**无落盘存活证据**（notifiedCount 只存在内存）」，可 v0.2.3（**同一次修订**）已经把状态落盘到 `<DSH_HOME>/context-reminder-state.json` ⇒ 同一个文件里前面说「已落盘」、后面说「只存在内存」。**教训：新增机制的同一提交里，要把所有「否定性断言」逐个找出来改**——`§9 修订记录` 写了新增，`§8/§10` 却还留着旧结论（与 `session-eject` 2026-09-22 那次同型：提交时间在后 ≠ 内容已吸收）。
  - 发现**新缺口（未修源码，只登记）**：`config.pruner.headChars/tailChars` 在 level 化后被绕过 ⇒ **静默失效的配置字段**（§10 U4）。此类「配置看起来还在、其实不再被读」的漂移，正是本源语义文档该管的东西。
- **2026-09-22 五次实践（梯级插话的两处缺陷 · 由 D3 触发复核；触发源 `src/index.ts` mtime）**
  - 语义**被补充**：主人指令「上下文感知要走插话形式」把通道 1 从**单一绝对阈值**改成**百分比梯级**（`warnAtPercents`，每档一次、去重落盘），旧阈值通道降为「窗口拿不到时的兜底」；两条子通道**共用一个投递口** `interject()`，保证「形式」永远一致。原文 §2 的「上下文提醒」定义只写了旧文案、§4.1 的配置表**根本没有 `warnAtPercents`** ⇒ 已一并回写（**再次印证上一节的教训：改了机制，同一提交里要把所有描述该机制的旧断言逐个找出来改**）。
  - 语义**被补充（两处实测缺陷 → I8/I9/I10）**：① **读数与投递错位一格**——梯级在 `turn/end` 读 `projectedTokens`＝651K/65%，而同一笔压缩在 **1.96s 后**才落地（`compaction-trace.jsonl`：`warnedAt=…102312` → `captured=…104272`），落地后真值 **95,218/10%**（`context_health` 现算，**同一个 `buildReport`**）⇒ 每次压缩后必然误报一次，代价是照它**再压一次**（≈1.13M tok）；② **压缩后不重新武装**——落盘 `warnedStep=65` 而用量 10% ⇒ 下次插话要等到 80%，自废 30 个点灵敏度。
  - 语义**被修正（闸门该加在哪一侧，按形状定）**：新增 `src/inflight-gate.ts` ⇒ **在飞即不评估**（作废源 `compaction/start` 早于读数就在事件流里，`region.ts:198`），**不采用**「投递前重验」——后者只覆盖几毫秒窗口，抓不到 1.96s 后才落地的作废。与通道 2 的 I3/I4 是**同一族但不同半边**，此处把「为什么不对称」写进不变量（I8），避免下次有人以为漏做。
  - 教训（**比缺陷本身更重要**）：**同宿主给既有机制新增通道时，必须把既有防线的每一半抄过来**。通道 2 早在 2026-09-14 就备好「在飞不报 + 投递前重验」双防线（同一个插件、注释里连事故日期都写着），而我给同一个插件新加梯级通道时**一条都没继承**。⇒ 判据：动手前先在**同文件/同插件**里搜一遍它治过的事故（**注释里的日期就是索引**），逐条对账「哪几半适用、为什么」。
  - 副作用面**如实登记**：③「在飞抑制」**不设独立侧车计数**（§8 ⑥ 写明理由：证据在权威源，重复记录会造第二个真源）。

## 10 · 未决问题

- **U1** 提醒是否该带**可执行动作**（如"要不要我压"）——倾向：不带，保持只送达（§2.1）
- **U2** 上下文提醒阈值（500k）与直触压缩阈值（`.dsh/compact-direct-policy.json`）是否应同源，避免"提醒了但没人压"或"压了但没提醒"
- **U3** 两条提醒通道需要落盘存活证据（`notifiedCount` / 最后投递时间），否则静默失效只能靠事后取证发现（§5.12 §3）——**2026-09-22 复核：部分结案**。已落盘：失败去重 seq（`failureSeqByAgent`）+ 上下文提醒的最后投递时刻（`warnedAtByAgent`）+ 梯级**已报最高档**（`warnedStepByAgent`）+ **重新武装去重 seq**（`rearmSeqByAgent`，后两者 2026-09-22 增）。**仍未落盘**：① 投递**计数**（`notifiedCount`——「这条通道一共报过几次」仍不可从外部读出）② **压缩告警**的投递时刻（只有 seq，没有 atMs）③ 投递**失败**的证据（I6 静默吞错 ⇒ 发送失败与「判据不成立」在外部不可区分）
- **U4**（2026-09-22 复核新增）`config.pruner.headChars/tailChars` 在 2026-09-20 level 化后**被静默绕过**（`prune_apply` 只读 `PRUNE_LEVELS[level]`）：保留（兼容旧配置、但值是死字段）还是映射成自定义档位、或从 schema 里删掉？倾向**保留 schema 但改注释 + 在 `prune_candidates` 输出里显式带上实际生效的 head/tail**（让「配置没生效」看得见，而不是靠读源码才知）
- **U5**（2026-09-22 五次实践新增）梯级通道的**抑制**（I8）与**重新武装**（I10）目前只在**内存/单测**层面被验；线上尚无「一次真实的压缩后被抑制、下一次压缩后重新武装」的完整观测记录（A14 标「线上待验收」）。要不要给通道 1 也加一条**投递/抑制的 atMs 轨迹**？（与 U3 ③ 同根，但**刻意与「不造第二真源」的取舍冲突** ⇒ 先记录，不急着做）
