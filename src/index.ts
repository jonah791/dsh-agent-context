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
import { watchCompaction } from './compaction-watch.ts';
// 2026-09-22：梯级读数在压缩落地前算、落地后才投递（实测差 1.96s）⇒ 算之前先过「在飞」闸门
import { DEFAULT_INFLIGHT_GRACE_MS, EMPTY_INFLIGHT_GATE, gateLadder } from './inflight-gate.ts';
import type { InflightGate } from './inflight-gate.ts';
// 2026-09-14：提醒状态落盘（治「重启即失忆 → 同一笔旧失败反复播报」）
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  EMPTY_REMINDER_STATE,
  parseReminderState,
  reminderStatePath,
  serializeReminderState,
  shouldNotifyFailure,
  shouldWarn,
  withFailureNotified,
  withWarned,
  nextWarnStep,
  withWarnedStep,
  withoutWarnedStep,
  shouldRearm,
  withRearmed,
  withoutFailure,
  withBoundaryReminded,
  lastRemindedBoundarySeq,
} from './reminder-state.ts';
// 2026-09-23 主人定调「压缩提醒太死板」：第三条通道——按**任务边界**提醒（读相关度，不只读占用）
import {
  watchTaskBoundary,
  measureCarryOver,
  decideTaskBoundaryHint,
  buildTaskBoundaryHintText,
  DEFAULT_TASK_LOOKBACK,
} from './task-boundary.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-agent-context': { kind: 'dsh-agent-context' }
  }
}

export const name = 'agent-context';
export const inject = ['commands', 'tokenMeter', 'sessionProjections', 'tools', 'agents'];

export interface Config {
  /** 上下文占用达到该阈值（tokens）时自动插话提醒（0 = 关闭）。**旧通道**：窗口拿不到时仍用它。 */
  warnThreshold: number
  /** 同一会话两次提醒的最小间隔（ms），防刷屏（只管**旧通道**）。 */
  warnCooldownMs: number
  /**
   * **梯级插话**的档位（百分比，升序）。2026-09-22 主人指令：「上下文感知要走插话形式」。
   * 拿得到 `contextWindow` 时按它递进：每跨过一档插一次话，**每档只插一次**（持久化去重）。
   * 空数组 = 关掉梯级通道，只剩旧通道。默认 [50, 65, 80, 90]。
   */
  warnAtPercents: number[]
  /**
   * **任务边界通道**开关（2026-09-23 主人定调）。
   *
   * 前两条通道（梯级 / 绝对阈值）都只读**占用**一个维度：1M 窗口下 50% 档恰等于旧通道的
   * 500000，两条实际重合在 500K，与任务结构无关。本通道补第二个维度——**与当前任务的相关度**
   * （可计算代理 = 跨界残留比），在 `goal/change` 构成的**任务边界**上提醒，
   * 于是「上一个任务留下大半噪音、新任务才刚开始」这种最该压的时刻能在 50% 之前被看见。
   */
  taskBoundaryHintEnabled: boolean
  /** 边界提醒的**残留 token 下限**：低于它压了也不省，不值得打扰（默认 30000）。 */
  taskBoundaryMinTokens: number
  /** 边界提醒的**残留占比下限**（0–1）：当前任务自己已占多数则不必压（默认 0.5）。 */
  taskBoundaryMinRatio: number
  /** 2026-08-21 合并：透传给 dsh-agent-context-pruner 的配置（可选覆盖，缺省用其默认值）。 */
  pruner?: Record<string, unknown>
}
export const Config = z.object({
  warnThreshold: z.number().default(500000),
  warnCooldownMs: z.number().default(3600000),
  warnAtPercents: z.array(z.number()).default([50, 65, 80, 90]),
  taskBoundaryHintEnabled: z.boolean().default(true),
  taskBoundaryMinTokens: z.number().step(1).min(0).default(30000),
  taskBoundaryMinRatio: z.number().min(0).max(1).default(0.5),
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
  // ── 提醒状态的持久化（2026-09-14）──
  // 去重/冷却原本只在内存（两个 Map）⇒ 每次 web 重启把**同一笔旧压缩失败**再播报一次
  // （实测：compaction/end seq=9088 的告警在 09:32:45 重启后重复投递 = 狼来了），
  // 且冷却归零会反复提醒同一会话。这与 §5.12 §3「提醒类机制要有存活证据」同根：
  // **状态只在内存 = 重启即失忆**。落盘后跨重启有效；坏数据一律回落空状态（fail-safe）。
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : homedir() + '/.dsh'
  const statePath = reminderStatePath(home)
  let reminderState = EMPTY_REMINDER_STATE
  try {
    reminderState = parseReminderState(JSON.parse(readFileSync(statePath, 'utf8')))
  } catch { /* 文件缺失/不可解析 → 空状态（照常工作） */ }
  /** 写盘 fail-safe：写失败不影响投递本身。 */
  const persistReminderState = (): void => {
    try {
      writeFileSync(statePath, serializeReminderState(reminderState), 'utf8')
    } catch { /* 写失败不阻塞 */ }
  }
  /** 梯级插话的「压缩在飞」抑制状态。内存计龄：重启归零是**正确**语义（跨重启的事务不可能还在飞）。 */
  let inflightGate: InflightGate = EMPTY_INFLIGHT_GATE;
  if (config.warnThreshold > 0 || config.warnAtPercents.length > 0) {
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
      /** 插话的**唯一投递口**：两条通道共用它，保证「形式」永远一致（主人 2026-09-22：「要走插话形式」）。 */
      const interject = (text: string): void => {
        // reenter 修复：延迟到当前 session.append 事务完成后投递
        setImmediate(() => {
          try {
            agent.send(
              createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'dsh-agent-context' },
              }),
              // next-step（主人 2026-08-25）：提醒插到下一帧之前，而非等到下一回合结束才注入
              'next-step',
              true,
            );
          } catch { /* 发送失败静默（agent 可能已销毁） */ }
        });
      };
      try {
        const readEvent = agent.session.eventAt.bind(agent.session) as (seq: number) => unknown;
        const watch = watchCompaction(readEvent, agent.session.seq);

        // ── ① 压缩成功后**重新武装**梯级（同一次压缩只清一次 · 先算、后应用）──────
        // 压缩是用量**合法回落**的唯一原因：此刻必须清掉已报档位，否则压缩一次就少 30 个点灵敏度
        // （实测：落盘 warnedStep=65、真实用量 10% ⇒ 下一次插话要等到 80%）。清档按 `compaction/end`
        // seq 去重并**落盘**——否则每个 turn/end 都清 = 梯级永不生效（反向刷屏）。
        // 失败结束（带 error）不清：上下文没缩小，档位继续有效。
        // 判据**先算**：闸门需要知道它（半边乙）；**应用**放在闸门之后——本轮即便被抑制，
        // 武装也必须完成，下一轮才能以干净档位评估。
        const endSeq = watch.endSeq;
        const rearmNeeded = !watch.inFlight && watch.failure === null && endSeq !== null
          && shouldRearm(reminderState, agent.id, endSeq);

        // ── ⓪ 读数新鲜度闸门（2026-09-22 两度实测缺陷）────────────────────────
        // 梯级读的是 projectedTokens（下次请求预计大小），而**压缩会让它作废**。两个半边：
        //   甲·压缩**在飞**：实测读到 651K/65%，同一笔压缩 1.96s 后落地、真值 95,218/10%；
        //   乙·压缩**刚被吸收**：实测 `rearmSeq` 前进到 23440 的**同一轮**又拿旧投影报了一次
        //      50 档（555K），而同一分钟的 `context_health` 读 92,015/9%。
        // 两种都会让我**照它再压一次**（≈1.13M tok 白烧）。语义与取舍见 inflight-gate.ts 文件头。
        const gated = gateLadder(
          inflightGate, agent.id, watch.inFlight, Date.now(), DEFAULT_INFLIGHT_GRACE_MS, rearmNeeded,
        );
        inflightGate = gated.gate;
        if (rearmNeeded && endSeq !== null) {
          reminderState = withoutWarnedStep(reminderState, agent.id);
          reminderState = withRearmed(reminderState, agent.id, endSeq);
          persistReminderState();
        }
        if (gated.suppressed) return;

        const report = buildReport(ctx.tokenMeter, ctx.sessionProjections, agent.session);
        const tokens = report.projectedTokens ?? report.totalTokens;

        // ── ① 占用维（梯级）+ 相关度维（任务边界）：先各自算判据，再合成**一条**插话 ──────
        // 2026-09-23 主人定调「压缩提醒太死板」：梯级与绝对阈值都只读**占用**——1M 窗口下
        // 50% 档恰等于旧通道的 500000，两条实际重合在 500K，与任务结构无关。第三条通道读
        // **任务边界**（`goal/change` 的 create/complete/clear）与**跨界残留比**，于是
        // 「上一个任务留下大半噪音、新任务才刚开始」这种最该压的时刻能在 50% 之前被看见。
        const step = nextWarnStep(
          config.warnAtPercents,
          tokens,
          report.contextWindow,
          reminderState.warnedStepByAgent[agent.id] ?? 0,
        );
        // 相关度维：开关关闭时**不读事件流、不量残留**（零额外开销）
        const measurement = config.taskBoundaryHintEnabled ? ctx.tokenMeter.measure(agent.session) : null;
        const boundary = measurement === null
          ? null
          : watchTaskBoundary(readEvent, agent.session.seq, DEFAULT_TASK_LOOKBACK);
        const carryOver = boundary === null || measurement === null
          ? { tokens: 0, ratio: 0 }
          : measureCarryOver(measurement.nodes, boundary.seq, measurement.surfaceTokens);
        const boundaryHit = measurement === null
          ? null
          : decideTaskBoundaryHint({
            boundary,
            carryOver,
            lastRemindedSeq: lastRemindedBoundarySeq(reminderState, agent.id),
            minTokens: config.taskBoundaryMinTokens,
            minRatio: config.taskBoundaryMinRatio,
          });

        if (step !== null || boundaryHit !== null) {
          const now = Date.now();
          // 先落盘再投递（同「先落盘」纪律）：投递失败也不会重复轰炸。
          // **两条通道各自推进自己的去重键**——否则被合成消息盖住的那条会在下一轮补报（双重打扰）。
          if (step !== null) reminderState = withWarnedStep(reminderState, agent.id, step.step);
          if (boundaryHit !== null) reminderState = withBoundaryReminded(reminderState, agent.id, boundaryHit.seq);
          reminderState = withWarned(reminderState, agent.id, now);
          persistReminderState();
          const parts: string[] = [];
          if (step !== null) {
            const win = report.contextWindow ?? 0;
            parts.push('【上下文提醒】上下文已用 **' + step.percent + '%**（约 '
              + (tokens / 1000).toFixed(0) + 'K / ' + (win / 1000).toFixed(0) + 'K）'
              + '——已跨过 ' + step.step + '% 档。建议压缩（/compact）或剪枝后再继续，避免超限中断。');
          }
          if (boundaryHit !== null) {
            parts.push(buildTaskBoundaryHintText({
              boundary: boundaryHit,
              carryOver,
              usedTokens: tokens,
              contextWindow: report.contextWindow,
            }));
          }
          interject(parts.join('\n'));
          return;
        }

        // ── ② 旧通道：绝对阈值 + 冷却（窗口拿不到 / 档位为空时仍可用）────────
        if (config.warnThreshold > 0 && tokens >= config.warnThreshold) {
          const now = Date.now();
          // 冷却判据读**落盘状态**（跨重启有效）；先落状态再投递（同失败通道的「先落盘」纪律）
          if (shouldWarn(reminderState, agent.id, now, config.warnCooldownMs)) {
            reminderState = withWarned(reminderState, agent.id, now);
            persistReminderState();
            interject('【上下文提醒】当前上下文约 '
              + (tokens / 1000).toFixed(0) + 'k tokens（阈值 '
              + (config.warnThreshold / 1000).toFixed(0) + 'k）——建议及时压缩（/compact）后再继续，避免超限中断。');
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
    ctx.on('session/event', (session: { id: string }, event: unknown) => {
      const ev = event as { type?: string }
      if (ev.type !== 'turn/end') return
      const agent = ctx.agents?.get(session.id as never)
      if (agent === undefined) return
      try {
        // 单一类型转换发生在边界；纯函数侧只认 (seq:number) => unknown。
        const readEvent = agent.session.eventAt.bind(agent.session) as (seq: number) => unknown
        const watch = watchCompaction(readEvent, agent.session.seq)
        // 飞行中不播报（2026-09-14 假告警事故）：此刻读到的「最近一次已结束的压缩失败」可能
        // 正被新一轮压缩取代；等它落定，下一个 turn/end 自会按结论播报。
        if (watch.inFlight) return
        const failure = watch.failure
        if (failure === null) {
          // 健康 → 清除该 agent 的失败记录（使将来的新失败仍能播报）
          const cleared = withoutFailure(reminderState, agent.id)
          if (cleared !== reminderState) {
            reminderState = cleared
            persistReminderState()
          }
          return
        }
        // 去重读**落盘状态**（2026-09-14 修复）：只读内存时，每次重启都会把同一笔旧失败
        // 再播报一次（seq=9088 实测重复投递 = 狼来了）。
        if (!shouldNotifyFailure(reminderState, agent.id, failure.seq)) return
        reminderState = withFailureNotified(reminderState, agent.id, failure.seq)
        persistReminderState()
        const text = '【压缩告警】上一次压缩**失败**，上下文没有缩小——'
          + failure.error
          + '（compaction/end seq=' + failure.seq + '）。'
          + '这是静默失效的高危信号：请先按事件流取证该错误再重试，不要当作已完成。';
        // reenter 修复（同 5.12）：延迟到当前 session.append 事务完成后投递。
        setImmediate(() => {
          try {
            // 投递前重验（2026-09-14 假告警事故）：读时是结论、投递时可能已过期——若已有
            // 更晚的 compaction/end 落定（成功或失败），本条告警作废，交给下一轮按新结论播报。
            const now = watchCompaction(readEvent, agent.session.seq)
            if (now.failure === null || now.failure.seq !== failure.seq) return
            agent.send(
              createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'dsh-agent-context' },
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