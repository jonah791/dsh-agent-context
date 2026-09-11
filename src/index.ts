/**
 * dsh-agent-context：感知当前会话的上下文占用与已花费 token。
 *
 * 只读聚合官方能力，不引入新计量：
 * - ctx.tokenMeter.measure(session) —— replay-aware 请求压力与 surface 测量
 * - ctx.sessionProjections.snapshot(session) —— tokenUsage（累计花费）、
 *   contextPressure（占用/容量）、contextBreakdown（组成）投影
 *
 * 提供：
 * 1) /context 命令 —— 人类可读中文报告（占用、花费、组成）
 * 2) ctx.contextMeter service —— 结构化 ContextReport（供其他插件消费）
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CommandInvocation } from '@deepseek-ai/dsh-commands';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
  TokenMeasurement,
  TokenUsageProjection,
} from '@deepseek-ai/dsh-token-meter';
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection';
import { formatReportText } from './format.js';
// 2026-08-21 合并 dsh-agent-context-pruner：剪枝工具 + 入口守卫已并入本包（src/pruner.ts）
import { applyPruner, Config as PrunerConfigSchema } from './pruner.ts';
// 2026-09-11 预防缺口修复：把已躺在事件流里的压缩失败浮出水面（durable ≠ visible）
import { latestCompactionFailure } from './compaction-watch.ts';

export const name = 'agent-context';
export const inject = ['commands', 'tokenMeter', 'sessionProjections', 'tools', 'agents'];

export interface Config {
  /** 上下文占用达到该阈值（tokens）时自动插话提醒（0 = 关闭）。 */
  warnThreshold: number
  /** 同一会话两次提醒的最小间隔（ms），防刷屏。 */
  warnCooldownMs: number
  /** 2026-08-21 合并：透传给 dsh-agent-context-pruner 的配置（可选覆盖，缺省用其默认值）。 */
  pruner?: Record<string, unknown>
}
export const Config = z.object({
  warnThreshold: z.number().default(500000),
  warnCooldownMs: z.number().default(3600000),
  pruner: z.any().required(false),
});

/** 一次感知快照：上下文占用 + 已花费 token + 组成。 */
export interface ContextReport {
  readonly sessionId: string;
  /** 投影快照一致读截止 seq（-1 = 空日志）。 */
  readonly asOfSeq: number;
  /** tokenMeter 已消费事件数。 */
  readonly logRevision: number;
  /** 最近一次请求的 provider 报告 prompt 大小；尚无 provider usage 时缺省。 */
  readonly pressureTokens?: number;
  /** 下次请求预计 prompt 大小（pressure + surface delta，provider 锚定）。 */
  readonly projectedTokens?: number;
  /** 当前测量总压力（baseline + surface delta）。 */
  readonly totalTokens: number;
  /** 当前 surface 总 heuristic token。 */
  readonly surfaceTokens: number;
  /** 当前 surface 消息数。 */
  readonly surfaceMessages: number;
  /** 最新路由模型的上下文容量；适配器未上报时缺省。 */
  readonly contextWindow?: number;
  /** 累计已花费（四桶互斥，reasoning 已含在 output 内）。 */
  readonly usage: TokenUsageProjection;
  /** 四桶合计。 */
  readonly usageTotal: number;
  /** 下次请求的启发式组成。 */
  readonly breakdown: ContextBreakdownProjection;
}

const EMPTY_USAGE: TokenUsageProjection = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const EMPTY_BREAKDOWN: ContextBreakdownProjection = {
  systemTokens: 0,
  toolsTokens: 0,
  messageTokens: 0,
};

/** 聚合依赖：tokenMeter.measure + sessionProjections.snapshot（纯函数，handler 与服务共用）。 */
export function buildReport(
  tokenMeter: { measure(session: Session): TokenMeasurement },
  sessionProjections: { snapshot(session: Session): ProjectionSnapshot },
  session: Session,
): ContextReport {
  const measurement = tokenMeter.measure(session);
  const snapshot = sessionProjections.snapshot(session);
  const values = snapshot.values;
  const usage = values.tokenUsage ?? EMPTY_USAGE;
  const usageTotal = usage.uncachedInputTokens
    + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
  const pressure: ContextPressureProjection | undefined = values.contextPressure;
  const breakdown = values.contextBreakdown ?? EMPTY_BREAKDOWN;
  return {
    sessionId: session.id,
    asOfSeq: snapshot.asOfSeq,
    logRevision: measurement.logRevision,
    pressureTokens: pressure?.pressureTokens,
    projectedTokens: pressure?.projectedTokens,
    totalTokens: measurement.totalTokens,
    surfaceTokens: measurement.surfaceTokens,
    surfaceMessages: measurement.nodes.length,
    contextWindow: pressure?.contextWindow,
    usage,
    usageTotal,
    breakdown,
  };
}

/** 上下文感知服务：ctx.contextMeter.report(session) 给出结构化快照（供其他插件注入消费）。 */
export class ContextMeter extends Service {
  static inject = ['tokenMeter', 'sessionProjections'];
  static Config = Config;
  constructor(ctx: Context, config: Config) {
    super(ctx, 'contextMeter');
  }
  /** 一次性聚合 token-meter 测量与 session-projection 快照。 */
  report(session: Session): ContextReport {
    return buildReport(this.ctx.tokenMeter, this.ctx.sessionProjections, session);
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    contextMeter: ContextMeter;
  }
}

/** 注册 /context 命令并挂载 contextMeter 服务。 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(ContextMeter, config);
  if (config.warnThreshold > 0) {
    const warnedAt = new Map<string, number>();
    // 2026-09-05 修复：触发时机从 agent/status(idle) 改为 session/event(turn/end)——原实现
    // 依赖 agent 状态转换（idle→running→idle），守护重启恢复的会话/长时间 running 的会话
    // 状态转换不完整 → 检查永不执行 → 压缩提醒从未触发（会话日志 0 条实证）。
    // turn/end 每轮对话结束必触发，不依赖状态机。同一回调内同步 agent.send 会 reenter，
    // 故用 setImmediate 延迟到 append 事务完成后投递（对齐 skill-forge 同款修复）。
    ctx.on('session/event', (session: { id: string }, event: unknown) => {
      const ev = event as { type?: string }
      if (ev.type !== 'turn/end') return
      const agent = ctx.agents?.get(session.id as never)
      if (agent === undefined) return // agent 未找到：跳过（不阻塞，下轮重试）
      try {
        const report = buildReport(ctx.tokenMeter, ctx.sessionProjections, agent.session);
        const tokens = report.projectedTokens ?? report.totalTokens;
        if (tokens >= config.warnThreshold) {
          const last = warnedAt.get(agent.id) ?? 0;
          const now = Date.now();
          if (now - last >= config.warnCooldownMs) {
            warnedAt.set(agent.id, now);
            const text = '【上下文提醒】当前上下文约 '
              + (tokens / 1000).toFixed(0) + 'k tokens（阈值 '
              + (config.warnThreshold / 1000).toFixed(0) + 'k）——建议及时压缩（/compact）后再继续，避免超限中断。';
            // reenter 修复：延迟到当前 session.append 事务完成后投递
            setImmediate(() => {
              try {
                agent.send(
                  createUserMessage({
                    content: [{ type: 'text', text }],
                    source: { kind: 'plugin', plugin: 'dsh-agent-context' },
                  }),
                  // next-step（主人 2026-08-25）：提醒插到下一帧之前，而非等到下一回合结束才注入
                  'next-step',
                  true,
                );
              } catch { /* 发送失败静默（agent 可能已销毁） */ }
            });
          }
        }
      } catch { /* 测量失败静默 */ }
    });
  }

  // 压缩失败守望（2026-09-11 预防缺口修复）：压缩失败此前只落一行 logger.warn——
  // dsh-agent-compact 的会话忙路径是 fire-and-forget（void run().then(..., logger.warn)），
  // 且 compactNow 忙时立即返回 null（工具面显示「压缩已启动」），错误回不到调用方。
  // 实测代价：10 次压缩全部失败、跨 2 天无人知晓，靠主人从「上下文没减少」的症状发现。
  // 这里在 turn/end（每轮必发，不依赖状态机——同 5.12 教训）读出最近的 compaction/end.error
  // 并投递提醒。fail-safe：纯读 + 字符串拼装，任何异常都静默 return，绝不影响会话或压缩本身。
  {
    /** 已提醒过的失败事件 seq（按 agent）。健康时清除，使后续新失败仍能提醒。 */
    const notifiedFailureSeq = new Map<string, number>();
    ctx.on('session/event', (session: { id: string }, event: unknown) => {
      const ev = event as { type?: string }
      if (ev.type !== 'turn/end') return
      const agent = ctx.agents?.get(session.id as never)
      if (agent === undefined) return
      try {
        // 单一类型转换发生在边界；纯函数侧只认 (seq:number) => unknown。
        const readEvent = agent.session.eventAt.bind(agent.session) as (seq: number) => unknown
        const failure = latestCompactionFailure(readEvent, agent.session.seq)
        if (failure === null) {
          notifiedFailureSeq.delete(agent.id)
          return
        }
        if ((notifiedFailureSeq.get(agent.id) ?? -1) >= failure.seq) return
        notifiedFailureSeq.set(agent.id, failure.seq)
        const text = '【压缩告警】上一次压缩**失败**，上下文没有缩小——'
          + failure.error
          + '（compaction/end seq=' + failure.seq + '）。'
          + '这是静默失效的高危信号：请先按事件流取证该错误再重试，不要当作已完成。';
        // reenter 修复（同 5.12）：延迟到当前 session.append 事务完成后投递。
        setImmediate(() => {
          try {
            agent.send(
              createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'plugin', plugin: 'dsh-agent-context' },
              }),
              'next-step',
              true,
            );
          } catch { /* 发送失败静默（agent 可能已销毁） */ }
        });
      } catch { /* 守望失败静默：绝不能因提醒而影响会话 */ }
    });
  }
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'context',
      description: 'Show context occupancy and tokens spent for this session',
      handler: (invocation: CommandInvocation) => {
        if (invocation.rawInput.trim().length > 0) {
          return { kind: 'error', text: 'Usage: /context (no arguments)' };
        }
        const report = buildReport(ctx.tokenMeter, ctx.sessionProjections, invocation.agent.session);
        return { kind: 'success', text: formatReportText(report) };
      },
    });
  }, 'agent-context lifecycle');

  // 2026-08-21 合并：本包内调用 applyPruner（剪枝工具 + 入口守卫）
  // pruner 配置用自身 zod schema 解析（补默认值）；context 配置里的 pruner 覆盖段可精确调整。
  const prunerRaw = (config as { pruner?: Record<string, unknown> }).pruner
  const prunerConfig = PrunerConfigSchema(prunerRaw ?? {})
  applyPruner(ctx as never, prunerConfig as never);
}