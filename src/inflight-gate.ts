/**
 * 梯级插话的「读数新鲜度」闸门（2026-09-22 两度实测缺陷）
 *
 * 梯级读的是 `projectedTokens`（下次请求预计大小）。**压缩会让这个读数作废**——所以闸门的
 * 唯一判据是：`读数是否晚于最后一次使它失效的事件`。这个判据有两个半边，缺一即漏：
 *
 * ## 半边甲 · 压缩**在飞**（2026-09-22 一测）
 * 现场：`session_compact` → 总结指令 → checkpoint → `turn/end` 触发梯级裁决，当场读到
 * **651K / 1M = 65%**，插话「已跨过 65% 档」。**但同一笔压缩在 1.96s 后才落地**
 * （`warnedAt=1790069102312` → `compaction/captured=1790069104272`）⇒ 投出的是**已作废的读数**；
 * 落地后真实占用 **95,218 = 10%**（`context_health` 现算，走同一个 `buildReport`）。
 * 代价：我会照它**再压一次**（两笔全上下文 ≈ 1.13M tok 白烧）。
 *
 * 为什么闸门放在「算之前」而不是「投递前重验」：压缩事务的 `compaction/start` **早于读数**
 * 就已经在事件流里（`region.ts:198`，事务最开头 append）——「在飞即不评估」才覆盖得住该形状；
 * 「投递前重验」只覆盖几毫秒，抓不到 1.96s 后的落地，故**不采用**（诚实边界，不是漏做）。
 *
 * ## 半边乙 · 压缩**刚被吸收**（2026-09-22 二测，甲上线后暴露的另一半）
 * 现场（`<DSH_HOME>/context-reminder-state.json` 实测，非构造）：
 * ```
 * "rearmSeqByAgent":   {"session-005ddf46…": 23440}   ← 由 22054 前进 ⇒ 重新武装本轮开火
 * "warnedStepByAgent": {"session-005ddf46…": 50}      ← 同一轮又报了一次 50 档
 * ```
 * 时序：压缩落地 → `rearmSeq` 前进（步①清档）→ **同一次回调**接着评估梯级，而此刻投影**还没有
 * 被任何新请求刷新**，仍是压缩前的 555K ⇒ 刚清完档就用陈旧读数开火，插话「已用 55%（约 555K）」
 * 而同一分钟的 `context_health` 读 **92,015 = 9%**。
 * ⇒ **「重新武装」只治了沉默（不再等到 80%），却把陈旧读数重新变成了可开火状态**——两半必须一起在。
 * 陈旧窗口恰为**一轮**：下一轮请求已挟带压缩后的表层，`buildReport` 随之新鲜（92,015 即证）。
 *
 * ## 有界抑制（跳过分支必须自愈 · AGENTS.md §5.17）
 * 半边甲的抑制状态在**内存**里计龄：若某个 `compaction/start` 超过 `graceMs` 仍无配对的
 * `compaction/end`（僵尸事务：进程在事务中途死掉，事件流永远留下未配对的 start），则**放行**梯级
 * ——否则一条僵尸 start 会把提醒通道永久静音，那正是「静默失效」（§5.10）。计龄刻意**不读事件时间
 * 字段**（不猜它的单位语义，只用本进程墙钟）；重启后 in-memory 归零是**正确**的：跨重启的事务不可能还在飞。
 * 半边乙**不需要**预算：它由「本轮是否武装」驱动，本身就是一次性、必自愈的。
 *
 * ## 怎么读证据（机制自证 · §5.22）
 * 状态文件的两个字段即可回答「沉默是因为被抑制、还是因为没跨档」：
 * `rearmSeqByAgent` 已随压缩前进、而 `warnedStepByAgent` 无新增 ⇒ **本轮被半边乙抑制**（正常）；
 * 两者都前进 ⇒ 抑制失效，陈旧读数漏了出去（缺陷）。
 */

/** 抑制状态：按 agent 记「第一次观测到压缩在飞」的时刻（ms）。 */
export interface InflightGate {
  readonly sinceByAgent: Record<string, number>
}

/** 空闸门。 */
export const EMPTY_INFLIGHT_GATE: InflightGate = Object.freeze({ sinceByAgent: {} })

/** 本轮梯级被抑制的原因（留痕/断言用）。 */
export type LadderSuppressReason =
  /** 压缩事务在飞：读数即将作废。 */
  | 'inflight'
  /** 压缩本轮刚被吸收：投影尚未刷新，仍是压缩前的值。 */
  | 'post-compaction'

/** 阶梯裁决结果。 */
export interface LadderGateVerdict {
  /** 新的闸门状态（未被改动时是**同一对象**，避免无谓写盘）。 */
  readonly gate: InflightGate
  /** 本轮是否抑制梯级评估。 */
  readonly suppressed: boolean
  /** 抑制原因（未抑制 ⇒ `null`）。 */
  readonly reason: LadderSuppressReason | null
}

/**
 * 默认抑制预算：压缩自己的总结超时是 120s（`summarizer.ts:381` 实测 waitSummaryTurn 120.0s），
 * 180s = 120s + 余量。超过它仍未配对 ⇒ 视为僵尸事务，不再静音提醒。
 */
export const DEFAULT_INFLIGHT_GRACE_MS = 180_000

/**
 * 裁决本轮梯级是否该被抑制（两个半边见文件头）。
 *
 * @param gate - 上一次的闸门状态
 * @param agentId - 目标 agent
 * @param inFlight - 压缩事务是否在飞（`watchCompaction(...).inFlight`）
 * @param nowMs - 当前时刻（本进程墙钟）
 * @param graceMs - 在飞预算（超过即视为僵尸事务，放行）
 * @param rearmedThisRound - 本轮是否刚为一次成功的压缩重新武装（`shouldRearm` 命中）
 * @returns 新闸门状态 + 是否抑制 + 抑制原因
 */
export function gateLadder(
  gate: InflightGate,
  agentId: string,
  inFlight: boolean,
  nowMs: number,
  graceMs: number = DEFAULT_INFLIGHT_GRACE_MS,
  rearmedThisRound: boolean = false,
): LadderGateVerdict {
  // ── 半边甲：在飞计龄（唯一有状态的一半）────────────────────────────────
  let next = gate
  let suppressedByInflight = false
  const since = gate.sinceByAgent[agentId]
  if (!inFlight) {
    // 不在飞：清掉计龄。无事可做时**保持同一对象**（零 churn）。
    if (since !== undefined) {
      const rest = { ...gate.sinceByAgent }
      delete rest[agentId]
      next = { sinceByAgent: rest }
    }
  } else if (since === undefined) {
    // 首次观测到在飞：起计龄，本轮回抑制。
    next = { sinceByAgent: { ...gate.sinceByAgent, [agentId]: nowMs } }
    suppressedByInflight = true
  } else {
    const elapsed = nowMs - since
    // 墙钟异常（elapsed 非有限/为负）一律按「仍在预算内」处理：宁可多静音一轮，也不误报过期读数。
    suppressedByInflight = !Number.isFinite(elapsed) || elapsed < graceMs
  }
  if (suppressedByInflight) return { gate: next, suppressed: true, reason: 'inflight' }

  // ── 半边乙：本轮刚吸收压缩（无状态；一次即自愈）──────────────────────
  if (rearmedThisRound) return { gate: next, suppressed: true, reason: 'post-compaction' }

  return { gate: next, suppressed: false, reason: null }
}
