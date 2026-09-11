/**
 * 压缩失败守望（预防缺口修复 · 2026-09-11）
 *
 * 事故背景：`dsh-agent-compact` 的会话忙路径是 fire-and-forget ——
 * `void run().then(..., error => logger.warn(...))`（index.ts:314-323），而
 * `compactNow` 在忙时**立即返回 null**，工具面渲染为「压缩已启动：…」。
 * 真正的提交发生在之后（模型输出 checkpoint 时），失败抛在事务提交阶段，
 * 因此错误**回不到工具调用方**，最终只落一行 logger.warn（进 .watch-web.log，无人读）。
 *
 * 实测代价：09-10 13:58 ~ 09-11 00:52 共 10 次压缩全部失败，每次会话事件流里
 * 都留下了 `compaction/end` + `error`（持久记录**存在**），却没有任何机制去读它
 * 并浮出水面——主人是靠「跑完了但上下文没减少」这个症状发现的。
 *
 * 本质：**durable ≠ visible**。日志只写不读，等于静默失效（AGENTS.md 5.10「静默失败
 * = 死亡温床」、5.12「提醒类机制要有存活证据」）。本模块只做一件最小的事：
 * 把已经躺在事件流里的失败读出来，交给提醒通道。
 *
 * 设计纪律（低爆炸半径）：
 * - 纯函数，无 IO、无时间、无宿主类型耦合——只在 `read`/`fromSeq` 上做有界回溯。
 * - **有界回溯**：只看尾部 `lookback` 个事件，不扫全库（长会话不可 O(n) 每轮重扫）。
 * - **只报「最近一次」压缩的结论**：最近一次 `compaction/end` 无错即视为健康，
 *   即使更早有过失败也不报（否则修好之后会一直报旧错误，制造狼来了）。
 */

/** 一次失败的压缩尝试：`compaction/end` 事件 seq（去重键）+ 失败原因全文。 */
export interface CompactionFailure {
  /** 承载该失败的 `compaction/end` 事件 seq——同一 seq 只提醒一次。 */
  readonly seq: number
  /** `compaction/end.data.error`（宿主写入的是 errorChain 字符串）。 */
  readonly error: string
}

/** 默认回溯窗口：足够覆盖一次到数轮对话内的压缩事件。 */
export const DEFAULT_LOOKBACK = 400

/** 判定为压缩失败所需的最小错误文本长度（防空串误报）。 */
const MIN_ERROR_LENGTH = 1

/**
 * 从会话尾部向前、在 `lookback` 窗口内找**最近一次** `compaction/end`，
 * 并在它携带错误时返回该失败。
 *
 * @param read - 按 seq 读取事件的读取器（调用方用 `session.eventAt` 包裹）。
 * @param fromSeq - 起点（通常是 `session.seq`：日志里最大的 seq）。
 * @param lookback - 最多向前回溯多少个 seq。
 * @returns 最近一次压缩失败；最近一次压缩成功 / 窗口内无压缩记录 → `null`。
 */
export function latestCompactionFailure(
  read: (seq: number) => unknown,
  fromSeq: number,
  lookback: number = DEFAULT_LOOKBACK,
): CompactionFailure | null {
  const floor = Math.max(0, fromSeq - lookback)
  for (let seq = fromSeq; seq >= floor; seq -= 1) {
    const event = read(seq) as { type?: unknown; data?: unknown } | undefined | null
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'compaction/end') continue
    const data = event.data as { error?: unknown } | undefined | null
    const error = data === null || typeof data !== 'object' ? undefined : data.error
    if (typeof error === 'string' && error.length >= MIN_ERROR_LENGTH) {
      return { seq, error }
    }
    // 最近一次 compaction/end 无错 = 当前健康；旧错误不报。
    return null
  }
  return null
}
