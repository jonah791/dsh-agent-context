# 语义文档：上下文治理与两条提醒通道（Context Governance & Reminders）

> 版本 v0.2.2 · 2026-09-14 · 作者：爱丽丝 · 状态：**已实现**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-context/src/{index,compaction-watch,pruner,format}.ts`
> 语义主副本：本文；压缩事务侧契约见 `self-plugins/dsh-agent-compact/docs/semantic.md`（互相指认）

---

## 1 · 定位与反定位

**定位**：上下文治理一体化插件——① `/context` 命令 + `ctx.contextMeter` 服务（结构化占用快照）② 剪枝工具族（`prune_candidates` / `prune_apply` / `expand` / `prune_guard` / `prune_stats` + 入口守卫折叠）③ **两条提醒通道**：【上下文提醒】（越阈值建议压缩）与【压缩告警】（上一次压缩失败）。

**反定位（本文不管什么）**：
- 不管压缩事务与捕获（→ `dsh-agent-compact`）
- 不管压缩入口/授权/直触（→ `dsh-compact-provider`）
- 不管**压缩提醒**（「压缩前建议先炼化」→ `dsh-agent-skill-forge`）——**两者不是一个东西**：上下文提醒讲占用，压缩提醒讲炼化时机
- **不是**自动执行器：本插件只**送达信号**，压缩与否由爱丽丝裁决（§2.1）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 提醒（reminder） | 由插件投递到会话的 user 消息（source.plugin 标明出处），只告知、不执行 |
| 上下文提醒 | `【上下文提醒】当前上下文约 Nk tokens（阈值 Mk）——建议及时压缩`，越 `warnThreshold` 触发 |
| 压缩告警 | `【压缩告警】上一次压缩**失败**，上下文没有缩小——<error>（compaction/end seq=N）` |
| 在飞行（inFlight） | 最近一次 `compaction/start` 晚于最近一次 `compaction/end`（结论未定） |
| 结局（outcome） | 最近一次 `compaction/end`：带 `error` = 失败，否则成功 |
| 投递前重验 | send 之前重读判据（关联 seq 是否仍是最近结论），不一致即作废 |
| 入口守卫 | 大工具结果在进上下文前折叠为「头 + 折叠标记 + 尾」（源头控制） |

## 3 · 概念模型

```
session/event(turn/end)  ← 每轮必发，不依赖状态转换（§5.12）
   ├─ 通道 1【上下文提醒】: tokenMeter/projection 量 → ≥ warnThreshold
   │      └─ 冷却（warnCooldownMs，按 agent 内存记）→ setImmediate → agent.send(text, 'next-step', true)
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

## 4 · 契约

### 4.1 服务 / 命令 / 工具
- 服务：`ctx.contextMeter`（`ContextMeter extends Service`，`report(session) → ContextReport`：占用/构成/健康）
- 命令：`/context`（无参数；打印占用与花费）
- 工具：`prune_candidates`（只读候选 + 剪后缓存代价）、`prune_apply`（按 seq 剪）、`expand`（按 callId 豁免折叠）、`prune_guard`（入口守卫开关/状态）、`prune_stats`（剪枝统计 + 缓存命中率）
- 配置：`warnThreshold`(500000) / `warnCooldownMs`(3600000) / `pruner{thresholdChars,headChars,tailChars,guardEnabled,guardThresholdChars,guardHeadChars,guardTailChars}`

### 4.2 裁决（纯函数优先）
- `watchCompaction(read, fromSeq, lookback=400) → {failure, endSeq, inFlight}`：一次扫描同时给「最近已结束的结论」与「是否在飞行」
- `latestCompactionFailure(read, fromSeq, lookback) → {seq, error}|null`：`watchCompaction().failure` 的薄包装（语义：最近一次已结束的压缩失败才算失败；旧错误不报）

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| 宿主事件 | `src/index.ts` `ctx.on('session/event')` ×2 | 通道 1（上下文提醒）与通道 2（压缩告警守望），均只在 `turn/end` |
| 宿主事件 | `src/index.ts` `ctx.on('session/event')`（pruner） | 大工具结果进上下文前折叠（入口守卫） |
| 命令面 | `src/index.ts` `ctx.commands.register({name:'context'})` | 手动体检 |
| 工具面 | `src/index.ts` → `applyPruner(ctx, cfg)` | 5 个剪枝工具 + 守卫 |

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：本插件防「上下文无声爆掉 + 压缩失败无声」，不防恶意调用，也不做鉴权
- 不越界清单：不触发压缩、不改写会话内容、不删事件（剪枝是表层折叠 + 日志保留）
- 失败面：① 提醒读失败/发送失败 → 静默 return（**代价**：只能靠日志与事件流反推；见 U3）② 剪枝写失败 → 报错不静默（工具面返回错误）③ 守卫开关读失败 → 保持现状（不静默改状态）

## 6 · 与既有机制的关系

- AGENTS.md **§5.12**（提醒机制防静默失效，含 §5 投递前重验）——本插件是这条规则的落点
- AGENTS.md **§5.10 §3**（静默失败 = 死亡温床）、**§5.18**（投递纪律：落到「我在的会话」）
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

## 8 · 与实现的关系

- 主实现：`src/index.ts`（两提醒通道 + 命令 + contextMeter）、`src/compaction-watch.ts`（纯判定）、`src/pruner.ts`（剪枝 + 入口守卫）、`src/format.ts`（报告格式化）
- 同语义副本：无；压缩事务侧（消费方）见 `dsh-agent-compact/docs/semantic.md`
- 未实现/未验证部分**显式标注**：① A10（`format.test.ts` 未被 test 脚本收集）② 提醒通道**无落盘存活证据**（§5.12 §3 建议的 notifiedCount 只存在内存）③ 提醒文本未做长度上限（超长上下文数字正常，但无截断保护）

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

## 10 · 未决问题

- **U1** 提醒是否该带**可执行动作**（如"要不要我压"）——倾向：不带，保持只送达（§2.1）
- **U2** 上下文提醒阈值（500k）与直触压缩阈值（`.dsh/compact-direct-policy.json`）是否应同源，避免"提醒了但没人压"或"压了但没提醒"
- **U3** 两条提醒通道需要落盘存活证据（`notifiedCount` / 最后投递时间），否则静默失效只能靠事后取证发现（§5.12 §3）
