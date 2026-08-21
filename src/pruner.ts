/**
 * dsh-agent-context-pruner → 并入 dsh-agent-context（2026-08-21 合并）。
 * 本文件为原 dsh-agent-context-pruner 的源码副本，apply 更名 applyPruner 以免与宿主冲突。
 * 上下文剪枝插件（爱丽丝判断为核心）
 *
 * 设计定调（2026-08-16 主人）：
 * - **核心准则（主人北极星）：「在不破坏缓存命中的情况下，让上下文大多数内容是有效的」**——
 *   缓存命中是底线（硬约束），内容有效性是目标。入口守卫（源头控制）是核心：大工具结果
 *   进上下文前折叠为头+尾+标记（确定性变换 → 缓存前缀稳定 → 命中率不破坏），
 *   事件日志原文保留（replay-safe）；事后剪枝只是历史遗留的补救。
 * - 「是否无用由爱丽丝自己判断」：插件只提供 候选检测（含缓存代价）+ 执行原语 + 统计，
 *   剪不剪、剪哪些、何时剪——决策归爱丽丝（自主性铁律：机制给原语不给剧本）
 * - 「不能破坏缓存命中」：候选按位置标注剪后缓存代价（其后内容重新 prefill 的一次性成本），
 *   尾部（tail）零破坏优先；中段大块仅在收益显著时剪（爱丽丝权衡）
 * - replay-safe：头+标记+尾替换（官方 dsh-compaction-tool-result-pruner 同款 surfaceOp replace），
 *   仅追加事件日志保留完整原始事件（可回放恢复）；替换前写 compaction/prune 定价事件
 * - 白名单：只剪 tool/result 节点；系统注入/主人消息/当前任务轮永不入候选
 * - 注意力保护（判断纪律，爱丽丝侧）：结论已落盘 + 可低成本重取 + 不在当前任务链，
 *   三条全满足才剪；剪前自问「主人下一句就问这个，我能答上来吗？」
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

export const prunerName = 'agent-context-pruner'
export const prunerInject = ['tools', 'tokenMeter'] as const

export interface Config {
  thresholdChars: number
  headChars: number
  tailChars: number
  /** 入口守卫开关：大工具结果在进入上下文前折叠（源头控制，2026-08-16 主人方案）。 */
  guardEnabled: boolean
  /** 守卫折叠阈值（码点）：超过则折叠为头+尾+标记。 */
  guardThresholdChars: number
  guardHeadChars: number
  guardTailChars: number
}

export const Config = z.object({
  thresholdChars: z.number().step(1).min(1).default(8192),
  headChars: z.number().step(1).min(0).default(4096),
  tailChars: z.number().step(1).min(0).default(1024),
  guardEnabled: z.boolean().default(true),
  guardThresholdChars: z.number().step(1).min(1).default(4096),
  guardHeadChars: z.number().step(1).min(0).default(1024),
  guardTailChars: z.number().step(1).min(0).default(512),
})

const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/** Unicode 码点长度（不拆 UTF-16 代理对）。 */
function codePointLength(text: string): number {
  return Array.from(text).length
}

/** 文本块码点总量（非文本块计零）。 */
function measureContent(blocks: readonly ContentBlock[]): number {
  let chars = 0
  for (const block of blocks) if (block.type === 'text') chars += codePointLength(block.text)
  return chars
}

/**
 * 头+标记+尾剪枝（官方 pruner 同款确定性逻辑）：保留头部预算、固定省略标记、尾部预算；
 * 非文本块保持原序；文本切片按码点不拆代理对。超预算返回替换，预算内返回 null（幂等）。
 */
function pruneContent(blocks: readonly ContentBlock[], thresholdChars: number, headChars: number, tailChars: number): ContentBlock[] | null {
  const totalChars = measureContent(blocks)
  if (totalChars <= thresholdChars) return null
  const removedStart = headChars
  const removedEnd = totalChars - tailChars
  const pruned: ContentBlock[] = []
  let consumed = 0
  let markerInserted = false
  for (const block of blocks) {
    if (block.type !== 'text') {
      pruned.push(block)
      continue
    }
    const points = Array.from(block.text)
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? PRUNE_MARKER : ''
    if (marker.length > 0) markerInserted = true
    const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('')
    if (text.length > 0) pruned.push({ ...block, text })
    consumed = blockEnd
  }
  if (!markerInserted) throw new Error('context-prune: failed to locate the removed text span')
  const charsAfter = measureContent(pruned)
  if (charsAfter > thresholdChars || charsAfter >= totalChars) throw new Error('context-prune: replacement must be smaller and within threshold')
  return pruned
}

/** tool/result 事件的收窄视图（官方 SessionEventMap 不含 surfaceOp 等扩展字段，运行时确有）。 */
interface ToolResultEventView {
  type: string
  data: {
    message: Message
    turn?: number
    step?: number
  }
}

/** 候选信息（只报信息，不判死活）。 */
interface CandidateInfo {
  seq: number
  turn: number | undefined
  step: number | undefined
  callId: string | undefined
  chars: number
  tokens: number
  overBudget: boolean
  cacheCostTokens: number
  positionHint: 'tail' | 'near-tail' | 'middle'
}

/** 一轮模型请求的实测 token 计量（provider usage 透传）。 */
interface TurnUsage {
  turn: number
  step: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** 缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)；无输入时为 null。 */
  hitRate: number | null
  at: string
}

/** 一次剪枝事件（命中率曲线上的标记点）。 */
interface PruneEvent {
  at: string
  seqs: number[]
  charsRemoved: number
}

/** 进程内累计统计（重启清零）。 */
interface PruneStats {
  count: number
  charsRemoved: number
  tokensRemoved: number
  lastAt: string
  /** turn → step → 每次模型请求的 usage（全记录，剪枝前后对比可观察即时影响）。 */
  turns: Map<number, Map<number, TurnUsage>>
  /** 剪枝事件时间线（与命中率曲线对齐）。 */
  pruneEvents: PruneEvent[]
}

function emptyStats(): PruneStats {
  return { count: 0, charsRemoved: 0, tokensRemoved: 0, lastAt: '', turns: new Map(), pruneEvents: [] }
}

export function applyPruner(ctx: Context, config: Config): void {
  console.log('[dsh-agent-context-pruner] apply', new Date().toISOString(), '(HMR probe)')

  // tokenMeter 服务（官方 dsh-token-meter；函数插件形态用类型断言获取，同 compaction seam 模式）
  const tokenMeter = (ctx as unknown as { tokenMeter: { estimateMessage(message: Message): number } }).tokenMeter
  const statsBySession = new Map<string, PruneStats>()

  // 入口守卫状态（进程内）：大工具结果进上下文前折叠；expand 按 callId 豁免
  const guard = {
    enabled: config.guardEnabled,
    exempt: new Set<string>(),
    folded: new Set<string>(),
    foldedCount: 0,
  }
  const guardMarker = (callId: string, chars: number): string =>
    '\n\n[guard: 大工具结果已折叠（原 ~' + chars + ' 码点；原文在会话日志，需要全文用 expand(callId="' + callId + '") 恢复）]'

  /** 扫描当前表层的 tool/result 候选（只读）。 */
  function scanCandidates(session: { id: string; surface: { nodes: readonly number[] }; events: Record<number, unknown> }): CandidateInfo[] {
    const nodes = [...session.surface.nodes]
    const tokenBySeq = new Map<number, number>()
    for (const seq of nodes) {
      const event = session.events[seq] as { data?: { message?: Message } } | undefined
      const message = event?.data?.message
      if (message !== undefined) tokenBySeq.set(seq, tokenMeter.estimateMessage(message))
    }
    const candidates: CandidateInfo[] = []
    for (let i = 0; i < nodes.length; i += 1) {
      const seq = nodes[i]
      if (seq === undefined) continue
      const event = session.events[seq] as unknown as ToolResultEventView | undefined
      if (event?.type !== 'tool/result') continue
      const message = event.data?.message
      if (message === undefined) continue
      const result = message.content[0]
      const blocks = result?.type === 'tool-result' ? result.content : undefined
      const chars = blocks === undefined ? 0 : measureContent(blocks)
      const tokens = tokenBySeq.get(seq) ?? 0
      let cacheCost = 0
      for (let j = i + 1; j < nodes.length; j += 1) {
        const s = nodes[j]
        if (s !== undefined) cacheCost += tokenBySeq.get(s) ?? 0
      }
      const remaining = nodes.length - i - 1
      const positionHint: CandidateInfo['positionHint'] = remaining <= 3 ? 'tail' : remaining <= 10 ? 'near-tail' : 'middle'
      candidates.push({
        seq,
        turn: event.data.turn,
        step: event.data.step,
        callId: (message.source as { callId?: string } | undefined)?.callId,
        chars,
        tokens,
        overBudget: chars > config.thresholdChars,
        cacheCostTokens: cacheCost,
        positionHint,
      })
    }
    return candidates
  }

  const pruneCandidatesTool: ToolDefinition = defineTool({
    name: 'prune_candidates',
    description: '上下文剪枝候选检测（只读）：扫描当前会话表层的工具结果节点，列出可剪候选——每个候选含 seq/轮次/大小/估算 token/是否超预算/剪后缓存代价（其后内容需重新 prefill 的一次性 token 成本）/位置提示（tail=零缓存破坏，near-tail=小代价，middle=大代价）。是否剪、剪哪些由爱丽丝判断：判断纪律三问「结论已落盘？可低成本重取？不在当前任务链？」全满足才值得剪；剪前自问「主人下一句就问这个，我能答上来吗？」',
    parameters: {
      minChars: { type: 'number', description: '只列出超过此字符数的候选（缺省用插件阈值，传 0 列出全部）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'number', required: true },
                positionHint: { type: 'string', required: true },
                chars: { type: 'number', required: true },
                tokens: { type: 'number', required: true },
                overBudget: { type: 'boolean', required: true },
                cacheCostTokens: { type: 'number', required: true },
                turn: { type: 'number' },
                callId: { type: 'string' },
              },
            },
            required: true,
          },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `候选 ${value.count} 个（minChars=${args.minChars ?? '缺省'}）——决策归爱丽丝` }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) return { count: 0, candidates: [], note: '无可用会话' }
      const minChars = (args.minChars as number | undefined) ?? config.thresholdChars
      const candidates = scanCandidates(session).filter((c) => c.chars >= minChars)
      return {
        count: candidates.length,
        candidates: candidates.map((c) => ({
          seq: c.seq,
          positionHint: c.positionHint,
          chars: c.chars,
          tokens: c.tokens,
          overBudget: c.overBudget,
          cacheCostTokens: c.cacheCostTokens,
          turn: c.turn,
          callId: c.callId,
        })),
        note: '剪枝判断归爱丽丝：tail 零缓存破坏可放心剪；middle 仅在「节省 × 剩余轮数 > 缓存代价」时剪',
      }
    },
  })

  const pruneApplyTool: ToolDefinition = defineTool({
    name: 'prune_apply',
    description: '执行上下文剪枝（可写）：按候选 seq 剪指定 tool/result 节点——头+标记+尾保留，replay-safe（仅追加日志保留完整原始事件，可回放恢复；每次替换前写 compaction/prune 定价事件）。不在表层/非 tool/result/预算内节点自动跳过，幂等。剪枝前请先跑 prune_candidates 并确认判断纪律。',
    parameters: {
      seqs: { type: 'array', items: { type: 'number' }, description: '要剪的候选 seq 列表（来自 prune_candidates）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pruned: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                originalSeq: { type: 'number', required: true },
                replacementSeq: { type: 'number', required: true },
                charsBefore: { type: 'number', required: true },
                charsAfter: { type: 'number', required: true },
                callId: { type: 'string' },
              },
            },
            required: true,
          },
          charsRemoved: { type: 'number', required: true },
          tokensRemoved: { type: 'number', required: true },
          stats: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'number', required: true },
              charsRemoved: { type: 'number', required: true },
              tokensRemoved: { type: 'number', required: true },
              lastAt: { type: 'string', required: true },
            },
            required: true,
          },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `已剪 ${value.pruned.length} 个节点，省 ${value.charsRemoved} 字符（约 ${value.tokensRemoved} token）` }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) return { pruned: [], charsRemoved: 0, tokensRemoved: 0, stats: { count: 0, charsRemoved: 0, tokensRemoved: 0, lastAt: '' }, note: '无可用会话' }

      const seqs = (args.seqs as number[] | undefined) ?? []
      if (seqs.length === 0) return { pruned: [], charsRemoved: 0, tokensRemoved: 0, stats: statsBySession.get(session.id) ?? { count: 0, charsRemoved: 0, tokensRemoved: 0, lastAt: '' }, note: '未指定 seqs（先跑 prune_candidates 查看候选）' }
      const nodes = new Set(session.surface.nodes)
      const pruned: { originalSeq: number; replacementSeq: number; charsBefore: number; charsAfter: number; callId?: string }[] = []
      let charsRemoved = 0
      let tokensRemoved = 0
      for (const seq of seqs) {
        if (!nodes.has(seq)) continue
        const event = session.events[seq] as unknown as ToolResultEventView | undefined
        if (event?.type !== 'tool/result') continue
        const message = event.data.message
        const result = message.content[0]
        if (result?.type !== 'tool-result') continue
        const content = pruneContent(result.content, config.thresholdChars, config.headChars, config.tailChars)
        if (content === null) continue
        const charsBefore = measureContent(result.content)
        const charsAfter = measureContent(content)
        const tokensBefore = tokenMeter.estimateMessage(message)
        const prunedMessage = freezeMessage({ ...message, content: [{ ...result, content }] })
        // compaction/prune 与 surfaceOp replace 是官方 compaction 插件的扩展事件契约
        // （官方 SessionEventMap 不含，运行时确有；与 dsh-agent-memory 的 compaction-sink 同款收窄）
        // 注意：append 必须保持 this 绑定（内部用 this.log）——解绑会报 reading 'log'
        const appendEvent = session.append.bind(session) as (type: string, data: unknown, opts?: unknown) => { seq: number }
        appendEvent('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: tokensBefore,
        })
        const replacement = appendEvent('tool/result', { ...event.data, message: prunedMessage }, {
          surfaceOp: { op: 'replace', start: seq, end: seq },
          sourceEventSeqs: [seq],
        })
        pruned.push({
          originalSeq: seq,
          replacementSeq: replacement.seq,
          charsBefore,
          charsAfter,
          callId: (message.source as { callId?: string } | undefined)?.callId,
        })
        charsRemoved += charsBefore - charsAfter
        tokensRemoved += tokensBefore
      }
      const prev = statsBySession.get(session.id) ?? emptyStats()
      const now = new Date().toISOString()
      if (pruned.length > 0) {
        prev.pruneEvents.push({ at: now, seqs: pruned.map((p) => p.originalSeq), charsRemoved })
      }
      const stats: PruneStats = {
        count: prev.count + pruned.length,
        charsRemoved: prev.charsRemoved + charsRemoved,
        tokensRemoved: prev.tokensRemoved + tokensRemoved,
        lastAt: now,
        turns: prev.turns,
        pruneEvents: prev.pruneEvents,
      }
      statsBySession.set(session.id, stats)
      // 返回给模型的 stats 必须为纯 JSON（turns 是 Map，仅内部使用）
      return {
        pruned,
        charsRemoved,
        tokensRemoved,
        stats: { count: stats.count, charsRemoved: stats.charsRemoved, tokensRemoved: stats.tokensRemoved, lastAt: stats.lastAt },
        note: '原始事件已保留于仅追加日志（可回放）；剪枝处留有标记，需要细节时可工具重取',
      }
    },
  })

  const expandTool: ToolDefinition = defineTool({
    name: 'expand',
    description: '恢复被入口守卫折叠的工具结果为全量（可写）：按 callId 豁免折叠，下一轮请求起该结果以全文进上下文（原文一直在会话日志中）。callId 从折叠标记或工具调用记录获取。',
    parameters: {
      callId: { type: 'string', required: true, description: '工具调用 id（折叠标记中可见）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          callId: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `已豁免 ${value.callId}——全文自下一轮起进上下文` }],
    },
    async execute(args, exec) {
      const callId = (args.callId as string | undefined) ?? ''
      if (callId.length === 0) return { callId: '', note: 'callId 不能为空（从折叠标记中获取）' }
      const session = exec.agent?.session
      guard.exempt.add(callId) // 先豁免，防止替换回的全量节点再次被折叠
      if (session === undefined) return { callId, note: '无可用会话；已加入豁免集' }
      // 找当前表层中 callId 匹配的 tool/result 节点
      for (const seq of [...session.surface.nodes]) {
        const ev = session.events[seq] as unknown as {
          type?: string
          data?: { message?: { source?: { callId?: string } } }
          sourceEventSeqs?: number[]
        } | undefined
        if (ev?.type !== 'tool/result') continue
        if (ev.data?.message?.source?.callId !== callId) continue
        // 原始全量事件（若当前是折叠替换节点，sourceEventSeqs[0] 指向原始）
        const originalSeq = ev.sourceEventSeqs?.[0] ?? seq
        const original = session.events[originalSeq] as unknown as { type?: string; data?: object } | undefined
        if (original?.type !== 'tool/result') continue
        const appendEvent = (session as unknown as { append: (t: string, d: unknown, o?: unknown) => { seq: number } }).append.bind(session)
        // 补 shadow-price claim：expand 恢复全量是 surface replace，token-meter 的
        // 投影 fold（O(1)）无法重建被替换的折叠范围，必须与 guard 折叠/剪枝对称地
        // 显式声明 claim——否则投影对 expanded 内容计 delta=0（低估），而压缩服务按
        // surface 节点估算 shadow（含全量）→ shadow > 投影 state → 压缩后投影
        // messageTokens 为负 → GUI 历史加载 zod 校验失败（2026-08-21 实测根因）
        appendEvent('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: tokenMeter.estimateMessage(ev.data.message as unknown as Message),
        })
        // sourceEventSeqs 必须包含被遮蔽的当前表层节点（seq 本身）；originalSeq 只是原文来源
        const replacement = appendEvent('tool/result', { ...original.data }, {
          surfaceOp: { op: 'replace', start: seq, end: seq },
          sourceEventSeqs: [seq],
        })
        return { callId, note: '已恢复全量（替换节点 ' + replacement.seq + '）；原文一直在会话日志中，replay-safe' }
      }
      return { callId, note: '未在当前表层找到该 callId 的 tool/result（可能已剪或已恢复）；已加入豁免集防未来折叠' }
    },
  })

  const guardTool: ToolDefinition = defineTool({
    name: 'prune_guard',
    description: '入口守卫状态（可写/只读）：大工具结果在进入上下文前被折叠为「头+尾+折叠标记」（源头控制，避免先全量 prefill 再剪）。mode=on/off 切换；缺省只读查看。',
    parameters: {
      mode: { type: 'string', enum: ['on', 'off'], description: '切换守卫开关（缺省只读查看）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
          thresholdChars: { type: 'number', required: true },
          headChars: { type: 'number', required: true },
          tailChars: { type: 'number', required: true },
          foldedCount: { type: 'number', required: true },
          exemptCount: { type: 'number', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `守卫 ${value.enabled ? '开启' : '关闭'}（已折叠 ${value.foldedCount} 个，豁免 ${value.exemptCount} 个）` }],
    },
    async execute(args, _exec) {
      const mode = args.mode as 'on' | 'off' | undefined
      if (mode === 'on' || mode === 'off') {
        guard.enabled = mode === 'on'
      }
      return {
        enabled: guard.enabled,
        thresholdChars: config.guardThresholdChars,
        headChars: config.guardHeadChars,
        tailChars: config.guardTailChars,
        foldedCount: guard.foldedCount,
        exemptCount: guard.exempt.size,
        note: '折叠只改发送形态（事件日志原文保留）；需要全文用 expand(callId) 豁免；guardEnabled 缺省配置可改',
      }
    },
  })

  const pruneStatsTool: ToolDefinition = defineTool({
    name: 'prune_stats',
    description: '上下文剪枝统计（只读）：本会话累计剪枝次数/节省字符/节省 token/最近剪枝时间 + 每轮缓存命中率（provider 实测 usage：cacheRead/(input+cacheRead+cacheWrite)）+ 剪枝事件时间线（与命中率曲线对齐，可观察剪枝是否破坏缓存命中）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stats: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'number', required: true },
              charsRemoved: { type: 'number', required: true },
              tokensRemoved: { type: 'number', required: true },
              lastAt: { type: 'string', required: true },
            },
            required: true,
          },
          cacheTurns: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                turn: { type: 'number', required: true },
                step: { type: 'number', required: true },
                inputTokens: { type: 'number', required: true },
                cacheReadTokens: { type: 'number', required: true },
                cacheWriteTokens: { type: 'number', required: true },
                outputTokens: { type: 'number', required: true },
                hitRate: { type: 'number' },
                at: { type: 'string', required: true },
              },
            },
            required: true,
          },
          pruneEvents: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                at: { type: 'string', required: true },
                seqs: { type: 'array', items: { type: 'number' }, required: true },
                charsRemoved: { type: 'number', required: true },
              },
            },
            required: true,
          },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `剪枝 ${value.stats.count} 次 / 省 ${value.stats.charsRemoved} 字符；缓存命中率记录 ${value.cacheTurns.length} 轮` }],
    },
    async execute(_args, exec) {
      const session = exec.agent?.session
      const stats = session === undefined ? undefined : statsBySession.get(session.id)
      const base = stats ?? emptyStats()
      const cacheTurns = [...base.turns.entries()]
        .sort((a, b) => a[0] - b[0])
        .flatMap(([turn, steps]) =>
          [...steps.entries()].sort((a, b) => a[0] - b[0]).map(([, u]) => ({
            turn,
            step: u.step,
            inputTokens: u.inputTokens,
            cacheReadTokens: u.cacheReadTokens,
            cacheWriteTokens: u.cacheWriteTokens,
            outputTokens: u.outputTokens,
            hitRate: u.hitRate ?? undefined,
            at: u.at,
          })))
      return {
        stats: { count: base.count, charsRemoved: base.charsRemoved, tokensRemoved: base.tokensRemoved, lastAt: base.lastAt },
        cacheTurns,
        pruneEvents: base.pruneEvents.map((p) => ({ at: p.at, seqs: p.seqs, charsRemoved: p.charsRemoved })),
        note: '命中率 = cacheRead/(input+cacheRead+cacheWrite)，provider 实测；剪枝事件与命中率曲线对齐可观察缓存影响；进程内累计（重启清零）',
      }
    },
  })

  // 每轮缓存命中率统计：监听 assistant/message 的 provider usage（实测），按 turn 覆盖式记录
  ctx.on('session/event', (session, event) => {
    const ev = event as unknown as {
      type: string
      data: {
        turn?: number
        step?: number
        usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
      }
    }
    // 入口守卫：tool/result 产生时立即折叠（模型首次看到的就是折叠版——原文从未进过上下文，
    // 无「先 prefill 再剪」的浪费；确定性折叠 → 缓存前缀稳定；expand(callId) 豁免）
    if (ev.type === 'tool/result') {
      // 入口守卫：异步折叠（setImmediate 避开事件派发中重入 append；失败打印不阻塞）
      setImmediate(() => {
        try {
          const msg = (ev.data as { message?: Message }).message
          const callId = (msg?.source as { callId?: string } | undefined)?.callId
          const result = msg?.content?.[0]
          if (!guard.enabled || callId === undefined || guard.exempt.has(callId) || result?.type !== 'tool-result') return
          const content = pruneContent(result.content, config.guardThresholdChars, config.guardHeadChars, config.guardTailChars)
          if (content === null) return
          const chars = measureContent(result.content)
          const marker: ContentBlock = { type: 'text', text: guardMarker(callId, chars) }
          const prunedMessage = freezeMessage({ ...(msg as Message), content: [{ ...result, content: [...content, marker] }] })
          const seq = (ev as unknown as { seq?: number }).seq
          const appendEvent = (session as unknown as { append: (t: string, d: unknown, o?: unknown) => { seq: number } }).append.bind(session)
          appendEvent('compaction/prune', {
            shadowedRange: { start: seq, end: seq },
            shadowedSeqs: [seq],
            shadowedTokenCount: tokenMeter.estimateMessage(msg as unknown as Message),
          })
          appendEvent('tool/result', { ...(ev.data as object), message: prunedMessage }, {
            surfaceOp: { op: 'replace', start: seq, end: seq },
            sourceEventSeqs: [seq],
          })
          if (!guard.folded.has(callId)) {
            guard.folded.add(callId)
            guard.foldedCount += 1
          }
          console.log('[guard] folded seq=' + String(seq) + ' callId=' + callId + ' chars=' + chars + ' -> ' + measureContent(content))
        } catch (err) {
          console.log('[guard] fold failed: ' + String(err))
        }
      })
      return
    }
    if (ev.type !== 'assistant/message') return
    const usage = ev.data.usage
    const turn = ev.data.turn
    if (usage === undefined || turn === undefined) return
    const input = usage.inputTokens ?? 0
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheWrite = usage.cacheWriteTokens ?? 0
    const output = usage.outputTokens ?? 0
    const total = input + cacheRead + cacheWrite
    const hitRate = total > 0 ? cacheRead / total : null
    const stats = statsBySession.get(session.id) ?? emptyStats()
    let steps = stats.turns.get(turn)
    if (steps === undefined) {
      steps = new Map()
      stats.turns.set(turn, steps)
    }
    steps.set(ev.data.step ?? 0, {
      turn,
      step: ev.data.step ?? 0,
      inputTokens: input,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: output,
      hitRate,
      at: new Date().toISOString(),
    })
    statsBySession.set(session.id, stats)
  })

  ctx.tools.register(pruneCandidatesTool)
  ctx.tools.register(pruneApplyTool)
  ctx.tools.register(pruneStatsTool)
  ctx.tools.register(expandTool)
  ctx.tools.register(guardTool)
  ctx.logger('dsh-agent-context-pruner').info('ready（prune_candidates / prune_apply / prune_stats 已注册）')
}
