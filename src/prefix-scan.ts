/**
 * 前缀分叉探测（2026-10-11 新增 · 借鉴 Headroom 的 CacheAligner 问题意识）。
 *
 * 问题：provider 的 KV-cache 按**请求前缀**命中。「这轮为什么没命中」过去只能猜。
 * 做法：比较相邻两次模型请求时的**表层节点序列**，算共同前缀长度。
 *
 * 为什么只比 seq 序列就够（而不必比内容）：
 * - 正常追加：旧序列是新序列的前缀 ⇒ 共同前缀 == 旧长度；
 * - 节点被替换（剪枝 / 压缩走 `surfaceOp: {op:'replace'}` 追加新事件）或移除：
 *   旧序列在对应位置上出现**不同的 seq** ⇒ 共同前缀提前结束。
 * 边界：表层 seq 单调递增，故「同一位置出现不同值」只可能来自替换/移除，不是重排。
 *
 * ⚠ 判据措辞的两个陷阱（2026-10-11 写测试时抓到的自我修正）：
 * 1. **`diverged` ≠ 缓存坏了**。缓存命中只到共同前缀 `shared` 为止——`shared` 之后的部分
 *    **本来就不在缓存里**。所以 `diverged` 描述的是「旧序列有多少没被保留」，
 *    真正决定命中多寡的是 `shared` 本身（越大命中越多）。
 * 2. **尾部截断也判 diverged**（旧序列的节点没了），但它同样不「破坏」任何已缓存内容。
 *    ⇒ 不要把 `diverged` 读成故障；要连 `shared` / `surfaceNodes` 一起读。
 */

/** 两次表层节点序列的共同前缀长度（长度不同时以短的为准）。 */
export function sharedPrefixLength(prev: readonly number[], next: readonly number[]): number {
  const limit = Math.min(prev.length, next.length)
  let k = 0
  while (k < limit && prev[k] === next[k]) k += 1
  return k
}

/** 旧序列在新序列里的保留形态。 */
export type PrefixVerdict =
  /** 旧序列原样是新序列的前缀（只是尾部追加）⇒ 上一轮整段前缀依然有效。 */
  | 'intact'
  /** 旧序列有节点未被保留（被替换 / 被移除）⇒ 共同前缀止于 `shared`，其后不再命中。 */
  | 'diverged'

/** 把「共同前缀长度」翻译成保留形态。调用方须以**非 null** 的 `prevLength` 调用（首次记录无基准）。 */
export function classifyPrefix(prevLength: number, shared: number): PrefixVerdict {
  return shared === prevLength ? 'intact' : 'diverged'
}

/** 旧序列被保留的比例（0–1）；`prevLength <= 0` 时返回 null（无基准）。 */
export function prefixRetention(prevLength: number, shared: number): number | null {
  if (prevLength <= 0) return null
  return shared / prevLength
}

/** 本次请求中「处于共同前缀内」的节点占比（≈ 可命中缓存的比例，以节点数近似 token 数）。 */
export function hitSpanRatio(surfaceLength: number, shared: number): number | null {
  if (surfaceLength <= 0) return null
  return shared / surfaceLength
}
