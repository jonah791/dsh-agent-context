<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 上下文治理一体化插件：/context 命令 + ctx.contextMeter 服务 + 剪枝工具族（prune_candidates/prune_apply/expand/prune_guard/prune_stats，含入口守卫折叠，合并自 dsh-agent-context-pruner）+ 两条提醒通道（上下文提醒 / 压缩告警，状态落盘跨重启去重）
  inject: 'commands','tokenMeter','sessionProjections','tools','agents'
  tools: prune_candidates,prune_apply,prune_stats,expand,prune_guard
  runtime: host-only
  envDeps: 无（纯逻辑/标准 Node；只读 DSH_HOME 环境变量并写一个状态 JSON，不依赖外部服务/网络）
  boundary: 只观测压缩事件流（compaction/start|end），不写压缩事件、不触发压缩；剪枝只折叠表层 + 保留仅追加日志（replay-safe）；提醒只送达不代裁
  compat: cordis ^4.0.1-rc.1 / dsh-tools ^0.1.0-rc.6 / schemastery ^3.18.1-rc.1 / dsh-agent·dsh-commands·dsh-session·dsh-session-projection·dsh-token-meter ^0.0.1-rc.1
-->
# dsh-agent-context

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-context"><img src="https://img.shields.io/badge/version-0.2.3-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-20%20passed-brightgreen" alt="tests">
</p>

**一句话**：一个「上下文仪表盘」加一套「剪枝工具」，外挂两条「提醒通道」——`/context` 报告 + `ctx.contextMeter` 服务给出现占用，5 个工具负责把上下文剪瘦，`:turn/end` 上的两个监听器在占用越阈值、或上一次压缩失败时，主动往会话里投一条提醒。

**为什么值得用**：上下文有两条「无声爆掉」的路径，官方只给原始材料、不给结论。

1. **占用越阈值没人喊**——官方 `dsh-token-meter` / `dsh-session-projection` 给的是投影读数，没有「快超限了」这一步。本插件在 `turn/end`（每轮必发）测量 `projectedTokens`，越阈值就用 `next-step` 插到下一帧之前提醒，并带冷却防刷屏。
2. **压缩失败只写不读**——压缩引擎的会话忙路径是 fire-and-forget（工具面回「压缩已启动」，真正的提交在之后），失败的 `error` **回不到工具调用方**，只落一行 `logger.warn`（宿主 logger 不落盘）。**durable ≠ visible**：实测 09-10 13:58 ~ 09-11 00:52 共 10 次压缩全部失败，事件流里每次都留了 `compaction/end` + `error`，跨 2 天无人知晓，最后靠主人从「跑完了但上下文没减少」的症状发现。本插件把这个已经躺在事件流里的失败读出来投递。
3. **长工具结果先全量 prefill 再剪是双重浪费**——入口守卫在工具结果**进入上下文之前**就折叠成「头 + 折叠标记 + 尾」，原文从未进过上下文，确定性折叠还让缓存前缀保持稳定；需要全文时 `expand(callId)` 按需恢复。

> 本插件**不做**：不触发压缩、不写压缩事件、不代替你决定压不压（只送达信号）；压缩提醒（「压缩前建议先炼化」）归 `dsh-agent-skill-forge`，不是本插件——两者不是一个东西。

## 能力

| 工具 | 用途 |
|------|------|
| `prune_candidates` | 只读候选检测：扫当前表层 `tool/result` 节点，报 `seq` / 轮次 / `chars` / 估算 `tokens` / 是否超预算 / **剪后缓存代价**（其后内容需重新 prefill 的一次性 token）/ 位置提示（`tail` 零缓存破坏、`near-tail` 小代价、`middle` 大代价）。只报信息，不判死活 |
| `prune_apply` | 按候选 `seq` 执行剪枝：头+标记+尾保留、幂等、replay-safe（仅追加日志保留完整原始事件，每次替换前写 `compaction/prune` 定价事件） |
| `expand` | 按 `callId` 豁免入口守卫折叠，恢复全量（原文一直在会话日志里）；顺带补 `compaction/prune` claim，防投影低估 |
| `prune_guard` | 入口守卫状态 / 开关（`mode: on/off`）：返回 `enabled` / `thresholdChars` / `headChars` / `tailChars` / `foldedCount` / `exemptCount` |
| `prune_stats` | 剪枝累计（次数 / 省字符 / 省 token / 最近时刻）+ 每轮**缓存命中率**（provider 实测 `cacheRead/(input+cacheRead+cacheWrite)`）+ 剪枝事件时间线（与命中率曲线对齐）。**进程内累计，重启清零** |

非工具面：

| 形态 | 内容 |
|------|------|
| 命令 | `/context`（无参数；`Show context occupancy and tokens spent for this session`）——人类可读中文报告：占用、已花费、组成 |
| 服务 | `ctx.contextMeter`（`ContextMeter extends Service`）→ `report(session)` 返回结构化 `ContextReport`（`pressureTokens`/`projectedTokens`/`totalTokens`/`surfaceTokens`/`contextWindow`/`usage` 四桶/`usageTotal`/`breakdown`），供其他插件消费 |
| 提醒通道 1 | `【上下文提醒】当前上下文约 Nk tokens（阈值 Mk）——建议及时压缩（/compact）后再继续，避免超限中断。` |
| 提醒通道 2 | `【压缩告警】上一次压缩**失败**，上下文没有缩小——<error>（compaction/end seq=N）。` |
| 入口守卫 | 大工具结果进上下文前折叠（`tool/result` 事件上 `setImmediate` 折叠，避开派发中重入 append） |

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-context": "link:<工作区>/self-plugins/dsh-agent-context"
```

**2) 挂组合**（`plugin_mount` 会自动写入；手工时写 profile 的 `cordis.patch.yml`；插件自带 `cordis.patch.yml` 片段）：

```yaml
- insert:
    - id: agent-context
      name: dsh-agent-context
      config:
        warnThreshold: 500000
        warnCooldownMs: 3600000
```

**3) 30 秒验证**：调 `/context` → 期望返回中文报告（占用 / 已花费 / 组成，形如 `约 566k tokens`）；调 `prune_guard`（不带参数）→ 期望 `enabled: true`、`thresholdChars: 4096`、`headChars: 1024`、`tailChars: 512`、`foldedCount: 0`；工具面应出现上表 5 个工具。

> 前置条件：官方 `dsh-token-meter` 与 `dsh-session-projection` 必须在生效组合内（web-app 已组合）——它们缺席时 `report` 读不到投影，工具与命令会报错而非静默给零。

## 配置

顶层（`src/index.ts` 的 `Config`）：

| 项 | 默认 | 说明 |
|----|------|------|
| `warnThreshold` | `500000` | 上下文占用（`projectedTokens ?? totalTokens`）达此值且通过冷却时投递【上下文提醒】；**`0` = 关闭该通道**（`if (config.warnThreshold > 0)` 整段不注册） |
| `warnCooldownMs` | `3600000` | 同一 agent 两次提醒的最小间隔（1h），防刷屏；判据读**落盘状态**（跨重启有效） |
| `pruner` | 未设（透传 `{}`） | 剪枝子配置覆盖段，缺省全部用下表默认值 |

`pruner` 子配置（`src/pruner.ts` 的 `Config`）：

| 项 | 默认 | 说明 |
|----|------|------|
| `thresholdChars` | `8192` | `prune_candidates` 的默认 `minChars`，也是 `prune_apply` 的剪枝预算（≤ 预算不剪，幂等） |
| `headChars` | `4096` | 保留头部码点预算 |
| `tailChars` | `1024` | 保留尾部码点预算 |
| `guardEnabled` | `true` | 入口守卫总开关；`prune_guard {mode:'off'}` 可在运行期改（**进程内，重启回到配置值**） |
| `guardThresholdChars` | `4096` | 守卫折叠阈值（码点） |
| `guardHeadChars` | `1024` | 守卫保留头部 |
| `guardTailChars` | `512` | 守卫保留尾部 |

## 落盘与自证（出问题时先看这里）

**唯一自有持久产物**：`${DSH_HOME}/context-reminder-state.json`（`DSH_HOME` 缺省回落 `~/.dsh`；`src/reminder-state.ts` 的 `reminderStatePath`）。它是**状态快照**（单行 JSON、人读友好），不是阶段轨迹：

| 字段 | 含义 |
|------|------|
| `failureSeqByAgent` | `agentId → 已播报过的压缩失败 compaction/end seq`。判据：`last < 本次 seq` 才播；最近一次压缩健康时该键被**清除**（使将来的新失败仍能播报） |
| `warnedAtByAgent` | `agentId → 上次【上下文提醒】投递时刻（ms）`，冷却判据 `now - last >= warnCooldownMs` |

**顺序纪律**：两条通道都是**先落盘状态、再 `setImmediate` 投递**——投递失败也不会重复播报。**fail-safe 方向**：文件缺失/损坏/形状不对一律回落 `EMPTY_REMINDER_STATE`（宁可在极端情况下重复播报一次，也不让提醒通道崩掉）；写盘失败吞错不阻塞投递。

**同类机制的第二类落盘面（写在会话事件流里，不是独立文件）**：每次剪枝/守卫折叠都会向会话仅追加日志写入一对事件——`compaction/prune`（定价/claim：`shadowedRange`/`shadowedSeqs`/`shadowedTokenCount`）+ `tool/result` 替换体（`surfaceOp: {op:'replace',startSeq,endSeq}`、`sourceEventSeqs`）。这是剪枝 **replay-safe 的证据层**：原文从不被删，只被遮。

**一条命令尽量答五问**（本插件只答得全 ②④，其余见注）：

```bash
tail -c 400 "$DSH_HOME/context-reminder-state.json"; stat -c '%y %n' lib/index.js
# ① 跑的是哪个构建 → 状态文件里没有 build 字段（缺口）；改用 mtime 对照：lib/index.js 的 mtime ≤ web 进程启动时间才算在跑它
# ② 谁发起 / 记了谁 → warnedAtByAgent 的键 = 被提醒的 agent id，值是投递时刻；failureSeqByAgent 的键 = 被处理过的 agent
# ③ 断在哪一段     → 无阶段枚举；warnedAtByAgent 长期不前进而上下文确已越阈值 ⇒ 提醒没发生（或在冷却窗口内）
# ④ 结果质量       → failureSeqByAgent[agent] 是否等于事件流里最新带 error 的 compaction/end seq；两键的键数是否按预期增长
# ⑤ 耗时与预算     → 无耗时字段；只能看同一 agent 两次 warnedAt 的间隔是否 ≥ warnCooldownMs(3600000)
```

**已知缺口（诚实声明）**：① 无 `<DSH_HOME>/context-*-trace.jsonl` 侧车轨迹，提醒通道没有 `notifiedCount` / 最后投递时间这类**存活证据**——静默失效只能靠事后取证（[`docs/semantic.md`](docs/semantic.md) §10 U3）；② `pruner.ts` 的 `console.log`（`[guard] folded seq=… callId=… chars=…`）走 web 进程 stdout、由守护重定向到日志文件，**不是插件自有产物，不得作为唯一证据**；③ `prune_stats` 的统计是进程内的，重启清零。

行为级验证（无需落盘）：调 `/context` 证明投影可读、调 `prune_guard` 证明守卫状态可读、调 `prune_stats` 证明统计与命中率记录可读。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. **进程级**：`lib/index.js` 的 mtime ≤ web 进程启动时间，且 `src/*.ts` 不新于 `lib/*.js`（源码改了没构建 = 跑的还是旧产物）；
2. **语义级**（最直接）：现读 `prune_guard`（无参）返回的 `thresholdChars`/`guardHeadChars`/`guardTailChars` 是否等于组合 `config:` 段里的值；工具面出现 5 个工具、`/context` 命令存在；
3. **行为级**：一次越阈值的 `turn/end` 之后，`${DSH_HOME}/context-reminder-state.json` 的 `warnedAtByAgent` 新增/前进；或投递出【上下文提醒】/【压缩告警】消息（`source.plugin = dsh-agent-context`）。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」（AGENTS §5.11 §6）。另注意 **`npm test` 不构建**（只跑 `tests/*.test.mjs`），而测试**导入的是 `../lib/*.js`**——改完源码务必先 `npm run build`，否则测试跑的是旧产物、假绿。
>
> 日志旁证（`ready（prune_candidates / prune_apply / prune_stats 已注册）`）走宿主 logger、**不落盘**，不得作为唯一证据。

**回退**（三档）：

- **源码级**：`git revert <commit>`（或 `git checkout <上一提交>`）→ `npm run build` → 预检 → 重启；回退后 5 个工具/`/context`/两条通道的行为回到旧版；
- **组合级**：profile patch 给该行加 `disabled: true`，或 `plugin_stop dsh-agent-context` → 停用后 5 个工具与 `/context` 消失、两条提醒通道停止投递、状态文件不再更新（**注意 `context-reminder-state.json` 会留在磁盘上**，重新启用后被沿用）；
- **运行期（局部，不改组合、不重启）**：`prune_guard {mode:'off'}` 关入口守卫；把 `warnThreshold` 配 `0` 关上下文提醒通道（需改组合生效）；删/清 `context-reminder-state.json` 复位去重与冷却状态（副作用：同一笔旧压缩失败会被**再播报一次**）。回退后用同一套判据复验。

## 测试

```bash
npm run build && npm test     # npm test = node --test "tests/*.test.mjs"
```

**20 例离线测试**，全部 `pass`（`node --test` 汇总：`# tests 20 / # pass 20 / # fail 0`），分文件实数：`tests/compaction-watch.test.mjs` **13** 例、`tests/reminder-state.test.mjs` **7** 例。测试从 `../lib/*.js` 导入，所以**必须先构建**（脚本本身不含 `tsc`）。

- `compaction-watch.test.mjs`（13）— 纯判定：**尸体测试**（最近一次 `compaction/end` 带错误 → 返回该失败与其 seq）、不误报四例（最近一次无错 / 错误之后有新的成功 / 窗口内无记录 / 空串或非字符串 error）、有界回溯（错误落在 `lookback=400` 之外 → `null`）、多个 end 取 seq 最大者、读取器返回 `null`/非对象/缺字段不崩、**飞行中不播报**（start 晚于最近 end → `inFlight=true`）、**投递前重验**（飞行那次成功落定 → `failure` 变 `null`；新失败落定 → 指向新 seq）、只有 start 从无 end 的退化样本。
- `reminder-state.test.mjs`（7）— 状态层：fail-safe（坏数据一律回落空状态、解析绝不抛）、**尸体测试**（同一失败 seq 跨重启不再重复播报，即事故 9088 形状）、健康后清除记录、冷却跨重启有效、`with*` 不可变更新、序列化往返、状态文件路径不产生双分隔符。

无需网络、无需真实外部依赖。**未覆盖**：① `tests/format.test.ts` **不在 `npm test` 的收集范围内**（glob 是 `tests/*.test.mjs`）——该文件当前**不参与回归**，是明确的已知缺口（[`docs/semantic.md`](docs/semantic.md) §7 A10、§8）；② ctx 级集成（造真 ctx 跑两个 `session/event` 监听器断言投递、真会话断言 `prune_apply` 的 `surfaceOp` 落地）；③ 守卫折叠与 `expand` 的端到端（需真实 `tool/result` 事件）。

## 设计要点

- **触发时机用「每轮必发」事件**：提醒挂在 `session/event` 的 `turn/end` 上，**不依赖 `agent/status` 状态转换**——旧实现依赖 idle↔running 转换，守护重启恢复的会话/长时间 running 的会话状态机不完整 → 检查永不执行 → 压缩提醒从未触发（会话日志 0 条实证）。
- **reenter 纪律**：事件回调内不直接 `agent.send`，一律 `setImmediate` 延迟到当前 `session.append` 事务完成之后。
- **读时结论 ≠ 投递时结论**：告警经延迟投递落地时，底下状态可能已变（实测 8092 start → 8108 end 无错，主人却收到**已过期**的失败告警）。防线两条：① `inFlight` 为真一律不播报；② `send` 之前**重读并比对关联 seq**，不再是同一 `failure.seq` 即作废，交给下一轮按新结论播报。
- **只报最近一次结论 + 有界回溯**：只读尾部 `lookback = 400` 个事件（长会话不可 O(n) 每轮重扫）；最近一次 `compaction/end` 无错即视为健康，不报历史旧错误（否则修好后会一直报 = 狼来了）。
- **提醒通道低爆炸半径**：任何异常都吞掉并 `return`，绝不影响会话与压缩本身。代价已诚实记录（无落盘存活证据，见 §5 缺口）。
- **剪枝 replay-safe 与契约键名**：只往仅追加日志写事件、不改写历史；`surfaceOp` 必须是**精确三键** `{op,startSeq,endSeq}`——旧键名 `{op,start,end}` 会在 `session.append` 处 **fail-loud** 被拒（替换体丢弃 = 剪枝静默失效）。
- **`compaction/prune` claim 必须与折叠对称**：投影 fold 是 O(1) 的，重建不了被替换的范围，所以 `prune_apply`/守卫折叠/`expand` 三处都要显式声明 `shadowedRange`——遗漏会让压缩后投影 `messageTokens` 为负、GUI 历史加载 zod 校验失败。
- **确定性折叠**：守卫按码点切「头 + 固定标记 + 尾」，同一输入得同一输出（缓存前缀稳定），不是随机截断；非文本块保持原序，切片不拆 UTF-16 代理对。
- **纯逻辑与接线分离**：`compaction-watch.ts` / `reminder-state.ts` 是不碰 IO、不碰 ctx、不取时间的纯函数，决策句法可离线单测；`index.ts` 只做读事件 → 裁决 → 落盘 → 投递。
- **反定位**：不是压缩引擎（不写 `compaction/*` 事务事件、不触发压缩）、不是自动决策器（只送达信号）、不是计量真源（读数来自官方 token-meter/projection）、不是鉴权层，也不防恶意调用（能力边界 ≠ 沙箱）。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型与 7 条不变量、契约（含调用点清单）、边界与信任、可证伪验收清单（A1–A11）、实践修订记录（4 次实践回修）、未决问题（U1–U3） |
| [`dsh-agent-compact/docs/semantic.md`](../dsh-agent-compact/docs/semantic.md) | 压缩事务侧契约（本插件只观测它的 `compaction/start|end`，不写） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `plugin-maintainability` / `dsh-plugin-development` / `context-stewardship` | 机制自证与可维护性工程、DSH 插件开发方法论、上下文自主管理 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
