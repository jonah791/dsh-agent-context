/**
 * 提醒投递状态的持久化（2026-09-14）
 *
 * ## 事故（反向的静默失效）
 * 两条提醒通道的去重状态原本只存在内存（`warnedAt` / `notifiedFailureSeq` 两个 Map）：
 * - 每次 web 重启都会把**同一笔旧压缩失败**再播报一次（实测：compaction/end seq=9088 的
 *   「上一次压缩失败」告警在 09:32:45 重启后重复投递），造成「狼来了」；
 * - 同时，重启也会让冷却（`warnCooldownMs`）归零，同一会话可能被反复提醒。
 *
 * 这是 AGENTS.md §5.12 §3「提醒类机制要有存活证据」的**镜像条款**：那条治「该报没报」，
 * 这条治「报过的又报」——两者同根：**状态只在内存 = 重启即失忆**。
 *
 * ## 契约
 * - 本模块**纯函数**（解析/序列化/裁决），IO 留在 `index.ts`。
 * - **fail-safe 方向：坏数据 → 空状态**（宁可在极端情况下重复播报一次，也不让提醒通道崩掉）。
 */

/** 持久化的提醒状态（按 agent id 分键，agent id 跨重启稳定）。 */
export interface ReminderState {
  /** 已播报过的失败 `compaction/end` seq（同一 seq 只播一次，跨重启有效）。 */
  readonly failureSeqByAgent: Record<string, number>
  /** 上次上下文提醒时刻（ms），用于**绝对阈值**通道的冷却。 */
  readonly warnedAtByAgent: Record<string, number>
  /**
   * 已提醒到的**梯级**（百分比档），用于**梯级插话**通道的去重（2026-09-22）。
   * 语义：数值 ＝ 该 agent 已经报过的最高档（如 50 档意味着 50% 报过、65% 未报）。
   */
  readonly warnedStepByAgent: Record<string, number>
}

/** 空状态（未授权/文件缺失/文件损坏一律回落到它）。 */
export const EMPTY_REMINDER_STATE: ReminderState = Object.freeze({
  failureSeqByAgent: {},
  warnedAtByAgent: {},
  warnedStepByAgent: {},
})

/** 只保留字符串键 → 有限数字值的记录（其余一律丢弃）。 */
function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === '' || typeof raw !== 'number' || !Number.isFinite(raw)) continue
    out[key] = raw
  }
  return out
}

/**
 * 解析状态文件内容。
 * @param raw - `JSON.parse` 后的值（文件缺失/损坏时调用方传 `null`）
 * @returns 合法状态；任何形状问题都回落到 {@link EMPTY_REMINDER_STATE}
 */
export function parseReminderState(raw: unknown): ReminderState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_REMINDER_STATE
  const record = raw as { failureSeqByAgent?: unknown; warnedAtByAgent?: unknown; warnedStepByAgent?: unknown }
  return {
    failureSeqByAgent: numberRecord(record.failureSeqByAgent),
    warnedAtByAgent: numberRecord(record.warnedAtByAgent),
    warnedStepByAgent: numberRecord(record.warnedStepByAgent),
  }
}

/**
 * 序列化状态（写入用）。
 * @param state - 当前状态
 * @returns 单行 JSON（便于人读与断言）
 */
export function serializeReminderState(state: ReminderState): string {
  return JSON.stringify({
    failureSeqByAgent: state.failureSeqByAgent,
    warnedAtByAgent: state.warnedAtByAgent,
    warnedStepByAgent: state.warnedStepByAgent,
  })
}

/**
 * **梯级插话**的裁决（2026-09-22 主人指令：「上下文感知要走插话形式」+ 主人手动报了「已用 57% ~568K/1M」）。
 *
 * 问题：原通道是**单一绝对阈值**（50 万 tokens）＋ **一小时冷却** ⇒ 用量爬到 57% 时仍被冷却压住，
 * 感知到不了我这儿，只能等主人手动插一句。⇒ 改为**随用量递进的档位**：每跨过一档就插一次话，
 * 每档只插一次（去重靠持久化的「已报最高档」，跨重启有效）。
 *
 * @param percents - 档位（升序、0–100）
 * @param usedTokens - 当前占用
 * @param contextWindow - 窗口容量（拿不到 ⇒ 返回 `null`，退回绝对阈值通道）
 * @param lastStep - 该 agent 已报过的最高档
 * @returns 该报的档（含实际百分比）；不该报或算不出 ⇒ `null`
 */
export function nextWarnStep(
  percents: readonly number[],
  usedTokens: number,
  contextWindow: number | undefined,
  lastStep: number,
): { step: number; percent: number } | null {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return null
  if (!Number.isFinite(usedTokens) || usedTokens < 0) return null
  const ratio = usedTokens / contextWindow
  let hit: number | null = null
  for (const p of percents) {
    if (!Number.isFinite(p) || p <= 0 || p > 100) continue
    if (ratio * 100 >= p && p > lastStep) hit = hit === null ? p : Math.max(hit, p)
  }
  if (hit === null) return null
  return { step: hit, percent: Math.round(ratio * 100) }
}

/** 记录一次梯级插话（不可变更新）。 */
export function withWarnedStep(state: ReminderState, agentId: string, step: number): ReminderState {
  const prev = state.warnedStepByAgent[agentId] ?? 0
  if (step <= prev) return state
  return { ...state, warnedStepByAgent: { ...state.warnedStepByAgent, [agentId]: step } }
}

/**
 * 是否该播报这次压缩失败。
 *
 * 判据：同一 agent 已播报过的 seq **大于等于**本次 seq → 不播（跨重启有效）。
 * @param state - 已加载的状态
 * @param agentId - 目标 agent
 * @param seq - 本次失败的 `compaction/end` seq
 * @returns 该播 → true
 */
export function shouldNotifyFailure(state: ReminderState, agentId: string, seq: number): boolean {
  const last = state.failureSeqByAgent[agentId]
  return last === undefined || last < seq
}

/**
 * 是否该发上下文提醒（冷却判据）。
 * @param state - 已加载的状态
 * @param agentId - 目标 agent
 * @param nowMs - 当前时刻
 * @param cooldownMs - 冷却窗口
 * @returns 该发 → true
 */
export function shouldWarn(
  state: ReminderState,
  agentId: string,
  nowMs: number,
  cooldownMs: number,
): boolean {
  const last = state.warnedAtByAgent[agentId] ?? 0
  return nowMs - last >= cooldownMs
}

/** 记录一次失败播报（不可变更新，返回新状态）。 */
export function withFailureNotified(state: ReminderState, agentId: string, seq: number): ReminderState {
  return { ...state, failureSeqByAgent: { ...state.failureSeqByAgent, [agentId]: seq } }
}

/** 记录一次上下文提醒时刻（不可变更新，返回新状态）。 */
export function withWarned(state: ReminderState, agentId: string, atMs: number): ReminderState {
  return { ...state, warnedAtByAgent: { ...state.warnedAtByAgent, [agentId]: atMs } }
}

/** 健康时清除该 agent 的失败记录（使将来的新失败仍能播报）。 */
export function withoutFailure(state: ReminderState, agentId: string): ReminderState {
  if (state.failureSeqByAgent[agentId] === undefined) return state
  const next = { ...state.failureSeqByAgent }
  delete next[agentId]
  return { ...state, failureSeqByAgent: next }
}

/**
 * 状态文件路径。
 * @param home - `DSH_HOME`
 * @returns `<home>/context-reminder-state.json`
 */
export function reminderStatePath(home: string): string {
  const sep = home.endsWith('/') || home.endsWith('\\') ? '' : '/'
  return home + sep + 'context-reminder-state.json'
}
