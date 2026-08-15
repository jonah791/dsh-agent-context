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
import type { Session } from '@deepseek-ai/dsh-session';
import type { CommandInvocation } from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
  TokenMeasurement,
  TokenUsageProjection,
} from '@deepseek-ai/dsh-token-meter';
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection';
import { formatReportText } from './format.js';

export const name = 'agent-context';
export const inject = ['commands', 'tokenMeter', 'sessionProjections'];

/** 零配置：感知是只读的，没有可调参数。 */
export interface Config {}
export const Config = z.object({});

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
}