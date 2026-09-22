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
