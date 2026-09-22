/**
 * 梯级插话的「压缩在飞」闸门（2026-09-22 实测缺陷）
 *
 * ## 现场（读数与投递错位一格）
 * 我调 `session_compact` → 引擎投递总结指令 → 我输出 checkpoint → `turn/end` 触发梯级裁决。
 * 梯级读的是 `projectedTokens`（下次请求预计大小），当场读到 **651K / 1M = 65%**，于是插话
 * 「已跨过 65% 档，建议压缩」。**但同一笔压缩在 1.96s 后才落地**（trace 实证：
 * `warnedAt=1790069102312` → `compaction/captured=1790069104272`）⇒ 我收到的是**已作废的读数**：
 * 压缩落地后真实占用 **95,218 = 10%**（`context_health` 现算，走同一个 `buildReport`）。
 * ⇒ **每次压缩后必然误报一次**，而代价是**我会照它再压一次**（两笔全上下文 ≈ 1.13M tok 白烧）。
 *
 * ## 为什么闸门放在「算之前」而不是「投递前重验」
 * 同插件的失败通道（`compaction-watch.ts`）用的是「飞行中不播报 + 投递前重验」双防线，治的形状是
 * **结论会被后来的结论取代**（失败 → 成功）。梯级通道的形状不同：**读数会被压缩作废**，而压缩
 * 事务的 `compaction/start` **早于读数**就已经在事件流里（`region.ts:198`，事务最开头 append，
 * 早于 summarize 与那 23s 等待）——所以「在飞即不评估」才是能覆盖该形状的那一半；「投递前重验」
 * 在这里只覆盖几毫秒的窗口，抓不到 1.96s 后的落地，故**不采用**（诚实边界，不是漏做）。
 *
 * ## 有界抑制（跳过分支必须自愈 · AGENTS.md §5.17）
 * 抑制状态在**内存**里计龄：若某个 `compaction/start` 超过 `graceMs` 仍无配对的 `compaction/end`
 * （僵尸事务：进程在事务中途死掉，事件流永远留下未配对的 start），则**放行**梯级——否则一条僵尸
 * start 会把提醒通道永久静音，那正是「静默失效」（§5.10）。计龄刻意**不读事件时间字段**
 * （不猜它的单位语义，只用本进程墙钟）；重启后 in-memory 归零是**正确**的：跨重启的事务不可能还在飞。
 */

/** 抑制状态：按 agent 记「第一次观测到压缩在飞」的时刻（ms）。 */
export interface InflightGate {
  readonly sinceByAgent: Record<string, number>
}

/** 空闸门。 */
export const EMPTY_INFLIGHT_GATE: InflightGate = Object.freeze({ sinceByAgent: {} })

/**
 * 默认抑制预算：压缩自己的总结超时是 120s（`summarizer.ts:381` 实测 waitSummaryTurn 120.0s），
 * 180s = 120s + 余量。超过它仍未配对 ⇒ 视为僵尸事务，不再静音提醒。
 */
export const DEFAULT_INFLIGHT_GRACE_MS = 180_000

/**
 * 裁决本轮梯级是否该被压缩在飞抑制。
 *
 * @param gate - 上一次的闸门状态
 * @param agentId - 目标 agent
 * @param inFlight - 压缩事务是否在飞（`watchCompaction(...).inFlight`）
 * @param nowMs - 当前时刻（本进程墙钟）
 * @param graceMs - 抑制预算（超过即视为僵尸事务，放行）
 * @returns 新闸门状态 + 是否抑制本轮评估
 */
export function gateLadder(
  gate: InflightGate,
  agentId: string,
  inFlight: boolean,
  nowMs: number,
  graceMs: number = DEFAULT_INFLIGHT_GRACE_MS,
): { gate: InflightGate; suppressed: boolean } {
  const since = gate.sinceByAgent[agentId]
  if (!inFlight) {
    // 不在飞：清掉计龄。无事可做时**返回原对象**（零 churn）。
    if (since === undefined) return { gate, suppressed: false }
    const next = { ...gate.sinceByAgent }
    delete next[agentId]
    return { gate: { sinceByAgent: next }, suppressed: false }
  }
  if (since === undefined) {
    // 首次观测到在飞：起计龄，本轮回抑制。
    return { gate: { sinceByAgent: { ...gate.sinceByAgent, [agentId]: nowMs } }, suppressed: true }
  }
  const elapsed = nowMs - since
  // 墙钟异常（elapsed 非有限/为负）一律按「仍在预算内」处理：宁可多静音一轮，也不误报过期读数。
  const suppressed = !Number.isFinite(elapsed) || elapsed < graceMs
  return { gate, suppressed }
}
