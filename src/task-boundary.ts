/**
 * 任务边界感知（2026-09-23 主人定调：压缩提醒去死板）
 *
 * ## 主人判据（原话）
 * 「现在的压缩提醒机制太死板了，定死了大于500K才压缩，但很多时候可以提早进行压缩，
 *   因为对于两个任务来说，做前一个任务时所积攒的大多数上下文是无用的，会影响下个任务的表现。」
 *
 * ## 缺口（现算的）
 * 本插件原有的两条通道都只读**占用**一个维度：
 *   · 梯级 `warnAtPercents`（默认 [50,65,80,90]）
 *   · 绝对阈值 `warnThreshold`（默认 500000）
 * 1M 窗口下 50% 档恰等于 50 万 tokens ⇒ **两条通道实际重合在 500K**，与任务结构无关。
 * 于是最该压的时刻（上一个任务留下大半噪音、新任务才刚开始）反而一声不响。
 *
 * 本模块补第二个维度：**与当前任务的相关度**。其可计算代理是**跨界残留比**——
 * 当前 surface 里落在任务边界**之前**的 token 占比。
 *
 * ## 任务边界不发明概念：用框架原生的 `goal/change`
 * `packages/goal/goal/src/domain.ts` 声明 `SessionEventMap['goal/change'] = GoalChangeMeta`，
 * 且该类型已登记在 `KNOWN_SESSION_EVENT_TYPES`。其中三个操作在语义上即任务边界：
 *   · `create`   —— 新任务在此刻开始
 *   · `complete` —— 任务在此刻结束（其后的工作属新任务）
 *   · `clear`    —— 任务被清除（同上）
 * `edit` / `pause` / `resume` / `block` **不是**边界（仍是同一个任务）。
 *
 * 选它作唯一信号的理由是**精度**：新 goal 就是新任务，不必猜（不靠话题漂移、时间空档这类
 * 需要主观阈值且易误报的判据）。代价是**召回**：不建 goal 的会话拿不到边界提醒——此时梯级
 * 通道照常兜底。取舍与已知边界见 `docs/semantic.md`。
 *
 * ## 设计纪律（同 `compaction-watch.ts`）
 * - 纯函数：无 IO、无时间、无宿主类型耦合——只在 `read` / `fromSeq` 上做**有界回溯**。
 * - 有界回溯：只看尾部 `lookback` 个事件，长会话不 O(n) 每轮重扫。
 */

/** 语义上构成任务边界的 `goal/change` 操作。 */
export type TaskBoundaryOperation = 'create' | 'complete' | 'clear'

/** 一次任务边界：承载它的 `goal/change` 事件 seq + 操作 + 目标摘要。 */
export interface TaskBoundary {
  /** 承载该边界的 `goal/change` 事件 seq——同一 seq 只提醒一次（去重键）。 */
  readonly seq: number
  /** 构成边界的操作。 */
  readonly operation: TaskBoundaryOperation
  /** 该操作携带的目标文本；`clear` 墓碑不带 goal，故缺省。 */
  readonly objective?: string
}

/** 默认回溯窗口：足够覆盖一次会话内的多次 goal 变更。 */
export const DEFAULT_TASK_LOOKBACK = 2000

/** 目标文本在提醒里的截断长度（提醒是插话，不搬运全文）。 */
const OBJECTIVE_CLIP = 60

const BOUNDARY_OPERATIONS: ReadonlySet<string> = new Set(['create', 'complete', 'clear'])

const OPERATION_LABEL: Record<TaskBoundaryOperation, string> = {
  create: '新任务开始',
  complete: '上一个任务结束',
  clear: '任务已清除',
}

/**
 * 目标文本的定语——**必须按操作区分**。
 * `create` 携带的是**新任务**的目标，`complete`/`clear` 携带的才是刚结束那个。
 * 2026-09-23 实测缺陷：首版一律写成「上一任务：「X」」，于是新任务开工时的提醒把**新目标**
 * 说成了上一个任务，读起来正好反了。
 */
const SUBJECT_LABEL: Record<TaskBoundaryOperation, string> = {
  create: '新任务',
  complete: '刚结束的任务',
  clear: '已清除的任务',
}

/** 计量节点的结构子集（`TokenMeasurement.nodes` 满足它，无需耦合宿主类型）。 */
export interface PricedNode {
  /** 该 surface 事件的持久 seq。 */
  readonly seq: number
  /** 该节点的路由价 tokens。 */
  readonly tokens: number
}

/** 跨界残留：落在任务边界之前的 token 量与其占 surface 的比例。 */
export interface CarryOver {
  /** 边界之前的 tokens 合计。 */
  readonly tokens: number
  /** `tokens / surfaceTokens`；`surfaceTokens <= 0` 时为 0。 */
  readonly ratio: number
}

/**
 * 从会话尾部向前、在 `lookback` 窗口内找**最近一次**构成任务边界的 `goal/change`。
 *
 * 只看最近一次：goal 变更在语义上是**替换**而非累积（新 goal 覆盖旧 goal 的边界），
 * 更早的边界已被它取代——按更早的边界算残留会把「上个任务 + 上上个任务」混为一谈。
 *
 * @param read - 按 seq 读取事件的读取器（调用方用 `session.eventAt` 包裹）。
 * @param fromSeq - 起点（通常是 `session.seq`：日志里最大的 seq）。
 * @param lookback - 最多向前回溯多少个 seq。
 * @returns 最近的任务边界；窗口内无 `goal/change` 或无边界操作 → `null`。
 */
export function watchTaskBoundary(
  read: (seq: number) => unknown,
  fromSeq: number,
  lookback: number = DEFAULT_TASK_LOOKBACK,
): TaskBoundary | null {
  const floor = Math.max(0, fromSeq - lookback)
  for (let seq = fromSeq; seq >= floor; seq -= 1) {
    const event = read(seq) as { type?: unknown; data?: unknown } | undefined | null
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'goal/change') continue
    const data = event.data as { operation?: unknown; goal?: unknown } | undefined | null
    if (data === null || typeof data !== 'object') continue
    const operation = data.operation
    if (typeof operation !== 'string' || !BOUNDARY_OPERATIONS.has(operation)) continue
    const goal = data.goal as { objective?: unknown } | undefined | null
    const objective = goal !== null && typeof goal === 'object' && typeof goal.objective === 'string'
      ? goal.objective
      : undefined
    const kind = operation as TaskBoundaryOperation
    return objective === undefined ? { seq, operation: kind } : { seq, operation: kind, objective }
  }
  return null
}

/**
 * 量出跨界残留：当前 surface 里落在边界**之前**的 token 量。
 *
 * 这是主人判据「做前一个任务时所积攒的上下文对下个任务大多无用」的可计算形式——
 * 不猜话题相关性，只数「边界之前还剩多少没被压掉」。
 *
 * @param nodes - 当前 surface 的计量节点（`TokenMeasurement.nodes`）。
 * @param boundarySeq - 任务边界的 seq；`seq < boundarySeq` 的节点算残留。
 * @param surfaceTokens - 当前 surface 总价（`TokenMeasurement.surfaceTokens`）。
 * @returns 残留 token 量与其占比。
 */
export function measureCarryOver(
  nodes: readonly PricedNode[],
  boundarySeq: number,
  surfaceTokens: number,
): CarryOver {
  let tokens = 0
  for (const node of nodes) {
    if (node.seq >= boundarySeq) continue
    if (!Number.isFinite(node.tokens) || node.tokens <= 0) continue
    tokens += node.tokens
  }
  const ratio = Number.isFinite(surfaceTokens) && surfaceTokens > 0 ? tokens / surfaceTokens : 0
  return { tokens, ratio }
}

/** 任务边界通道的裁决输入。 */
export interface TaskBoundaryHintInput {
  /** 最近的任务边界（`watchTaskBoundary` 的结果）。 */
  readonly boundary: TaskBoundary | null
  /** 该边界下的跨界残留量。 */
  readonly carryOver: CarryOver
  /** 已提醒过的边界 seq（`-1` = 从未提醒）。 */
  readonly lastRemindedSeq: number
  /** 残留 token 下限：低于它压了也不省，不值得打扰。 */
  readonly minTokens: number
  /** 残留占比下限（0–1）：当前任务自己已占多数时不必压。 */
  readonly minRatio: number
}

/**
 * 裁决是否投递任务边界提醒。
 *
 * 四条判据全满足才投（**精度优先**：误报的代价是一次白压，约百万 token）：
 *   ① 有边界，且该边界**未提醒过**（按 seq 去重，跨重启有效）；
 *   ② 残留 token ≥ `minTokens`；
 *   ③ 残留占比 ≥ `minRatio`；
 *   ④ 参数有限（配置异常一律不投——fail-safe 方向是安静，不是乱报）。
 *
 * @param input - 见 {@link TaskBoundaryHintInput}。
 * @returns 该投递的边界；不该投 → `null`。
 */
export function decideTaskBoundaryHint(input: TaskBoundaryHintInput): TaskBoundary | null {
  const boundary = input.boundary
  if (boundary === null) return null
  if (boundary.seq <= input.lastRemindedSeq) return null
  if (!Number.isFinite(input.minTokens) || input.minTokens < 0) return null
  if (!Number.isFinite(input.minRatio) || input.minRatio < 0 || input.minRatio > 1) return null
  if (!Number.isFinite(input.carryOver.tokens) || input.carryOver.tokens < input.minTokens) return null
  if (!Number.isFinite(input.carryOver.ratio) || input.carryOver.ratio < input.minRatio) return null
  return boundary
}

/** 把目标文本截到 `OBJECTIVE_CLIP`（超出加省略号）。 */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= OBJECTIVE_CLIP ? flat : flat.slice(0, OBJECTIVE_CLIP) + '…'
}

/**
 * 任务边界提醒文案（插话形式，与梯级通道共用同一投递口）。
 *
 * 说清三件事：**刚跨过什么边界**、**多少是残留**、**为什么此刻压最划算**——
 * 提醒要给判断依据，不只给命令。
 *
 * @param input.boundary - 命中的任务边界。
 * @param input.carryOver - 跨界残留量。
 * @param input.usedTokens - 当前上下文占用（用于算出「属于当前任务」的部分）。
 * @param input.contextWindow - 窗口容量（拿不到则只报绝对值）。
 * @returns 中文提醒全文。
 */
export function buildTaskBoundaryHintText(input: {
  boundary: TaskBoundary
  carryOver: CarryOver
  usedTokens: number
  contextWindow?: number
}): string {
  const stale = Math.round(input.carryOver.tokens / 1000)
  const fresh = Math.max(0, Math.round((input.usedTokens - input.carryOver.tokens) / 1000))
  const percent = Math.round(input.carryOver.ratio * 100)
  const subject = input.boundary.objective === undefined
    ? ''
    : '（' + SUBJECT_LABEL[input.boundary.operation] + '：「' + clip(input.boundary.objective) + '」）'
  const window = input.contextWindow === undefined || input.contextWindow <= 0
    ? ''
    : ' / ' + Math.round(input.contextWindow / 1000) + 'K'
  return '【上下文提醒·任务边界】刚跨过任务边界（' + OPERATION_LABEL[input.boundary.operation] + '）'
    + subject + '——当前约 ' + Math.round(input.usedTokens / 1000) + 'K' + window + ' 里，'
    + '约 **' + stale + 'K（' + percent + '%）是边界之前的残留**，只约 ' + fresh + 'K 属于当前任务。'
    + '按「旧任务的上下文是下个任务的噪音」判据，**此刻压缩收益最高**（不必等到 50% 档）：'
    + '建议 /compact 后再继续。'
}
