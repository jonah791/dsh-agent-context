/**
 * 「压缩在飞」闸门单测（2026-09-22 实测缺陷）
 *
 * 现场（本次会话实证，非构造）：
 *   warnedAt=1790069102312  ← 梯级在 turn/end 读到 651K/1M = 65%，投递「已跨过 65% 档」
 *   captured=1790069104272  ← 同一笔压缩在 **1.96s 后**才落地
 *   落地后真实占用 = 95,218 / 1,000,000 = 10%（context_health 现算，同一个 buildReport）
 * ⇒ 投递的是一条已作废的读数；代价是**我会照它再压一次**（≈1.13M tok）。
 *
 * 运行：`node --test tests/*.test.mjs`（先 `npm run build` 产出 lib/）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INFLIGHT_GRACE_MS,
  EMPTY_INFLIGHT_GATE,
  gateLadder,
} from '../lib/inflight-gate.js';
import { nextWarnStep } from '../lib/reminder-state.js';

const AGENT = 'session-005ddf46-13b3-4b73-9779-269daadaf57b';
/** 现场时刻：梯级读数那一刻（ms）。 */
const T_WARN = 1_790_069_102_312;
/** 现场时刻：压缩落地那一刻（ms）。 */
const T_CAPTURED = 1_790_069_104_272;

test('★ 尸体样本：压缩在飞 ⇒ 抑制本轮梯级（现场：651K/65% 那一轮必须不投递）', () => {
  const first = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, true, T_WARN);
  assert.equal(first.suppressed, true, '在飞时的读数即将作废 ⇒ 必须抑制');
  // 即便再过 1.96s（落地时刻）仍在飞 ⇒ 仍抑制（读数此刻已经作废，更不能投）
  const still = gateLadder(first.gate, AGENT, true, T_CAPTURED);
  assert.equal(still.suppressed, true);
});

test('在飞结束后放行，且计龄被清（下次在飞重新起算）', () => {
  const opened = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, true, T_WARN);
  const closed = gateLadder(opened.gate, AGENT, false, T_CAPTURED);
  assert.equal(closed.suppressed, false, '不在飞 ⇒ 放行（此时读数已是压缩后的真值）');
  assert.equal(closed.gate.sinceByAgent[AGENT], undefined, '计龄必须清掉');
  // 清掉之后再在飞 ⇒ 重新起算，仍抑制
  const reopened = gateLadder(closed.gate, AGENT, true, T_CAPTURED + 1_000);
  assert.equal(reopened.suppressed, true);
});

test('幂等/零 churn：不在飞且无记录 ⇒ 返回**同一对象**（不产生无谓写盘与状态漂移）', () => {
  const same = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, false, T_WARN);
  assert.equal(same.gate, EMPTY_INFLIGHT_GATE, '无事发生不得换对象');
  assert.equal(same.suppressed, false);
  // 在预算内连续抑制时同样不换对象（只读 elapsed）
  const opened = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, true, T_WARN);
  const again = gateLadder(opened.gate, AGENT, true, T_WARN + 1_000);
  assert.equal(again.gate, opened.gate, '连续在飞期间闸门状态不变（同一对象）');
});

test('★ 对照组：僵尸事务（未配对的 compaction/start）超预算 ⇒ **必须放行**，不许永久静音', () => {
  // 进程在事务中途死掉 ⇒ 事件流永远留下未配对的 start ⇒ inFlight 恒 true。
  // 若此处仍抑制，提醒通道就被一条僵尸 start 永久静音（§5.10 静默失效）。
  const opened = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, true, T_WARN);
  const withinBudget = gateLadder(opened.gate, AGENT, true, T_WARN + DEFAULT_INFLIGHT_GRACE_MS - 1);
  assert.equal(withinBudget.suppressed, true, '预算内仍抑制（真在飞的压缩最长 120s）');
  const beyondBudget = gateLadder(opened.gate, AGENT, true, T_WARN + DEFAULT_INFLIGHT_GRACE_MS);
  assert.equal(beyondBudget.suppressed, false, '超预算 ⇒ 视为僵尸，放行（否则通道永不开口）');
  assert.equal(beyondBudget.gate.sinceByAgent[AGENT], T_WARN, '超预算不放行计龄重置（否则会无限延长静音）');
});

test('预算常量必须**长于压缩自身的 120s 总结超时**（仪器先量后设，不拍脑袋）', () => {
  // 依据：summarizer.ts:381 实测 waitSummaryTurn 120.0s（start 11:06:48 → summary 11:08:48）
  assert.equal(DEFAULT_INFLIGHT_GRACE_MS, 180_000);
  assert.ok(DEFAULT_INFLIGHT_GRACE_MS > 120_000, '预算短于仪器自身超时 ⇒ 会把真在飞的压缩当成僵尸');
});

test('墙钟异常（时刻倒退 / NaN）⇒ 按「仍在预算内」处理（宁可多静音一轮，也不误报过期读数）', () => {
  const opened = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, true, T_WARN);
  assert.equal(gateLadder(opened.gate, AGENT, true, T_WARN - 60_000).suppressed, true, '时刻倒退');
  assert.equal(gateLadder(opened.gate, AGENT, true, Number.NaN).suppressed, true, 'NaN');
});

test('按 agent 分键：一个会话压缩在飞，别的会话照常评估', () => {
  const other = 'session-879c4ae1-b33e-43de-91d3-a968a6af6f2c';
  const gated = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, true, T_WARN);
  assert.equal(gateLadder(gated.gate, other, false, T_WARN).suppressed, false, '别的会话不得被牵连');
  assert.equal(gated.gate.sinceByAgent[other], undefined);
});

// ── 半边乙：压缩**刚被吸收**（2026-09-22 二测，现场态非构造）────────────────────

/**
 * 现场读数：陈旧投影（压缩前那一笔请求）。
 * 取值由**线上插话原话反解**：「已用 55%（约 555K / 1000K）」⇒ `round(ratio*100)=55`
 * 且 `(tokens/1000).toFixed(0)="555"` ⇒ tokens ∈ [554.5K, 555K)。取 554,800 同时满足两者。
 */
const T_STALE_TOKENS = 554_800;
/** 现场真值：同一分钟的 `context_health` 现算（压缩后 9%）。 */
const T_TRUE_TOKENS = 92_015;
/** 现场窗口容量。 */
const T_WINDOW = 1_000_000;
/** 现场档位表（`config.warnAtPercents`）。 */
const T_PERCENTS = [50, 65, 80, 90];

test('★ 尸体样本（二测）：本轮刚重新武装 ⇒ 抑制，且**抑制掉的正是会开火的那一档**', () => {
  // 现场：`rearmSeqByAgent` 由 22054 前进到 23440（步①清了档），紧接着**同一轮**又报了一次 50 档。
  // 两段合起来才构成证据：① 陈旧读数确实会开火；② 闸门确实把它按住了。
  const wouldFire = nextWarnStep(T_PERCENTS, T_STALE_TOKENS, T_WINDOW, 0);
  assert.deepEqual(wouldFire, { step: 50, percent: 55 },
    '陈旧读数（约 555K/1M，已清档）本来会开火——这就是被抑制掉的那一枪（与线上插话原话同值）');

  const gated = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, false, T_WARN, DEFAULT_INFLIGHT_GRACE_MS, true);
  assert.equal(gated.suppressed, true, '刚吸收压缩 ⇒ 投影尚未刷新 ⇒ 不得评估');
  assert.equal(gated.reason, 'post-compaction');
});

test('★ 对照组：同一读数、同样已清档，但**本轮没武装** ⇒ 必须放行（否则半边乙会永久静音）', () => {
  const gated = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, false, T_WARN, DEFAULT_INFLIGHT_GRACE_MS, false);
  assert.equal(gated.suppressed, false, '没吸收压缩 ⇒ 读数是新鲜的，照常评估');
  assert.equal(gated.reason, null);
});

test('半边乙**恰抑制一轮**（自愈，无需预算）：下一轮即放行', () => {
  const first = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, false, T_WARN, DEFAULT_INFLIGHT_GRACE_MS, true);
  assert.equal(first.suppressed, true);
  // 下一轮的请求已挟带压缩后的表层 ⇒ buildReport 随之新鲜（现场：92,015 = 9%）
  const next = gateLadder(first.gate, AGENT, false, T_WARN + 1_000, DEFAULT_INFLIGHT_GRACE_MS, false);
  assert.equal(next.suppressed, false);
  assert.deepEqual(nextWarnStep(T_PERCENTS, T_TRUE_TOKENS, T_WINDOW, 0), null,
    '真值 92,015 ⇒ 连最低档都不该报（这正是陈旧读数与真值的分野）');
});

test('半边乙**不动闸门状态**（无状态 ⇒ 零 churn：抑制一轮不得产生写盘或状态漂移）', () => {
  const gated = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, false, T_WARN, DEFAULT_INFLIGHT_GRACE_MS, true);
  assert.equal(gated.gate, EMPTY_INFLIGHT_GATE, '乙是纯判据，不得改闸门对象');
});

test('两半同现（人为构造）⇒ 归因到「在飞」：先失效的那个原因优先', () => {
  const gated = gateLadder(EMPTY_INFLIGHT_GATE, AGENT, true, T_WARN, DEFAULT_INFLIGHT_GRACE_MS, true);
  assert.equal(gated.suppressed, true);
  assert.equal(gated.reason, 'inflight', '在飞是更强的失效源（读数此刻已被取代，且要计龄）');
  assert.equal(gated.gate.sinceByAgent[AGENT], T_WARN, '在飞仍要起计龄（僵尸预算才不会漏）');
});
