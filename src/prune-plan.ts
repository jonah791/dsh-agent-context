/**
 * 剪枝档位与内容指纹（2026-09-20，学习移植）
 *
 * **来源**：GitHub 一周热点巡检发现的 `tamaratran/fast-jev-compaction`（★4.6k，MIT）。
 * 它做上下文压缩的方式与我不同——不问「剪不剪」，而是**问两个独立问题**：
 *   ① 这个 call 还有意义吗（知道它做过、带输入，是否仍重要）
 *   ② 这个 result 还需要逐字保留吗（**重跑工具能否替代**）
 * 据此落到**三态**：`keep` / `drop_result`（保 call 痕迹、result 截断+注记）/ `drop_call`。
 * 另有一个 **6 级渐进收缩**阶梯，每级只在上一级不够时才用（最小必要损伤），
 * 且 stats 里回报 `stateStage` —— 直接回答「断在哪一级」。
 *
 * **移植内容**（不引入它的 Jev 依赖 —— 我不把上下文命运交给第三方付费服务，§5.25）：
 *   - **渐进降级** → 三档 `PruneLevel`（L1 保守 / L2 加强 / L3 只留注记），各级字符账可见，
 *     **选哪档由爱丽丝决定**（§2.1 决策归我；工具只给信息，不替我剪）
 *   - **第二问的可计算代理** → `ContentFlags`：从内容指纹读出「重跑工具能否替代」的信号
 *     （报错 / 路径 / 唯一 ID ⇒ 重取不到或昂贵 ⇒ 保守；同质大块 ⇒ 可重取 ⇒ 可激进）
 *
 * ⚠ 边界诚实：指纹是**启发式代理**，不是语义判断本身。它把「重跑能否替代」从
 * 完全靠记忆的问题，降级为「有信号可依 + 最终仍归我判断」——不假装它能替代判断。
 *
 * 纯函数：无 IO、无时间依赖，便于离线单测（tests/prune-plan.test.mjs）。
 */

/** 剪枝档位（渐进降级；数字越小越保守） */
export type PruneLevel = 'L1-head-tail' | 'L2-heavy' | 'L3-note-only'

/** 各档位的头/尾保留预算（码点） */
export const PRUNE_LEVELS: Record<PruneLevel, { headChars: number; tailChars: number }> = {
  'L1-head-tail': { headChars: 4096, tailChars: 1024 },
  'L2-heavy': { headChars: 1024, tailChars: 256 },
  'L3-note-only': { headChars: 0, tailChars: 0 },
}

export const LEVEL_ORDER: readonly PruneLevel[] = ['L1-head-tail', 'L2-heavy', 'L3-note-only']

/** 注记本身的开销（估算；L3 的替换文本长度上限） */
export const NOTE_OVERHEAD_CHARS = 120

export interface ContentFlags {
  /** 含报错/异常栈 —— 重跑未必复现同一现场 */
  hasError: boolean
  /** 含文件路径 —— 重取要再读一次 */
  hasPaths: boolean
  /** 含唯一 ID / 哈希 / 长 token —— 重取拿不到同一个值 */
  hasUniqueIds: boolean
  /** 含命令行 —— 往往是结论性内容 */
  hasCommands: boolean
  /** 同质大块（重复行多）—— 最可能可重取 */
  homogeneous: boolean
  /** 命中信号名列表（人读） */
  flags: string[]
  /** 是否含「重取不到或昂贵」的信号 ⇒ 建议保守（L1） */
  irreplaceable: boolean
}

const RE_ERROR = /(?:^|\n)\s*(?:Traceback|at\s+\S+\s*\(|Caused by:)|(?:error|exception|failed|fatal|panic)\b|(?:报错|异常|失败|错误)/i
const RE_PATHS = /(?:[A-Za-z]:\\[^\s"']+|\/(?:mnt|home|usr|etc|var|tmp)\/[\w./-]+|\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|py|json|md|yml|yaml|toml|sh|ps1)\b)/
const RE_UNIQUE = /\b[0-9a-f]{16,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[A-Za-z0-9_-]{32,}\b/
const RE_COMMANDS = /(?:^|\n)\s*(?:\$|>|npm|pnpm|yarn|git|python3?|node|curl|wget|docker|kubectl|tsc|pytest)\s/

/**
 * 内容指纹：从原始文本读出「重跑工具能否替代」的代理信号。
 * 只看文本特征，不做语义理解 —— 所以它给的是**倾向**，不是结论。
 */
export function inspectContent(text: string): ContentFlags {
  const hasError = RE_ERROR.test(text)
  const hasPaths = RE_PATHS.test(text)
  const hasUniqueIds = RE_UNIQUE.test(text)
  const hasCommands = RE_COMMANDS.test(text)

  // 同质判据：行够多、且重复行占比高（列表/日志/表格的典型形状）
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  const unique = new Set(lines.map((line) => line.trim()))
  const homogeneous = lines.length >= 20 && unique.size / lines.length < 0.5

  const flags: string[] = []
  if (hasError) flags.push('error')
  if (hasPaths) flags.push('paths')
  if (hasUniqueIds) flags.push('unique-ids')
  if (hasCommands) flags.push('commands')
  if (homogeneous) flags.push('homogeneous')

  return {
    hasError,
    hasPaths,
    hasUniqueIds,
    hasCommands,
    homogeneous,
    flags,
    irreplaceable: hasError || hasUniqueIds || (hasPaths && !homogeneous),
  }
}

/**
 * 建议档位（只是建议 —— 最终剪哪档、剪不剪，归爱丽丝）。
 * 逻辑对齐 fast-jev-compaction 的第二问：**重跑工具能否替代**。
 *   - 含不可重取信号（报错/唯一 ID/非大块路径）⇒ L1（保守，保头尾轮廓）
 *   - 同质大块（重复率高）⇒ L3（只留一行注记 —— 反正能重取）
 *   - 其余 ⇒ L2（加强截断）
 */
export function suggestLevel(flags: ContentFlags): PruneLevel {
  if (flags.irreplaceable) return 'L1-head-tail'
  if (flags.homogeneous) return 'L3-note-only'
  return 'L2-heavy'
}

export interface LevelPlan {
  level: PruneLevel
  headChars: number
  tailChars: number
  /** 该档剪完后的码点数（不足预算时等于原值 —— 该档无效） */
  charsAfter: number
  /** 该档能省下的码点 */
  savedChars: number
  /** 是否值得用（savedChars > 0） */
  effective: boolean
}

/**
 * 三档字符账：让「各级能省多少」可见，选哪档由主体定。
 * @param totalChars 原始内容码点数
 * @returns 按 LEVEL_ORDER 排列的三档方案（含无效档，便于对照）
 */
export function planLevels(totalChars: number, noteChars: number = NOTE_OVERHEAD_CHARS): LevelPlan[] {
  return LEVEL_ORDER.map((level) => {
    const { headChars, tailChars } = PRUNE_LEVELS[level]
    const kept = level === 'L3-note-only' ? noteChars : headChars + tailChars
    const charsAfter = Math.min(totalChars, kept)
    const savedChars = totalChars - charsAfter
    return { level, headChars, tailChars, charsAfter, savedChars, effective: savedChars > 0 }
  })
}
