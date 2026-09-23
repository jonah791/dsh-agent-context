/**
 * task-boundary 单测：任务边界感知的压缩提醒（2026-09-23 主人定调「压缩提醒太死板」）
 *
 * 纪律（AGENTS.md §5.9 §2）：防线必须有**尸体测试**——好样本不误报、坏样本必触发。
 * 特别地，本文件含**对照组**（无 `goal/change` 的会话 ⇒ 边界通道恒不投递），
 * 用来证明判据有分辨力：若实现退化成「恒发」，对照组会红。
 *
 * 运行：node --test "tests/*.test.mjs"（读 lib/，需先 npm run build）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  watchTaskBoundary,
  measureCarryOver,
  decideTaskBoundaryHint,
  buildTaskBoundaryHintText,
  DEFAULT_TASK_LOOKBACK,
} from '../lib/task-boundary.js';

/** 构造按 seq 取事件的读取器。 */
function readerOf(events) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return (seq) => bySeq.get(seq);
}

/** 构造一条 `goal/change` 事件（载荷形状对齐 GoalSnapshotChangeMeta）。 */
function goalChange(seq, operation, objective) {
  const data = { kind: 'goal/change', version: 1, operation };
  if (objective !== undefined) {
    data.goal = { id: 'g1', revision: 1, objective, phase: 'active', maxGoalRounds: 10 };
  }
  return { seq, type: 'goal/change', data };
}

// ---------- watchTaskBoundary：边界识别 ----------

test('对照组：无 goal/change 的会话 ⇒ 边界为 null（边界通道恒不投递）', () => {
  const read = readerOf([
    { seq: 10, type: 'user/message', data: {} },
    { seq: 11, type: 'turn/end', data: {} },
  ]);
  assert.equal(watchTaskBoundary(read, 11), null);
});

test('create 是任务边界，带出 objective', () => {
  const read = readerOf([goalChange(500, 'create', '补全智能体网络基础设施')]);
  const b = watchTaskBoundary(read, 500);
  assert.notEqual(b, null);
  assert.equal(b.seq, 500);
  assert.equal(b.operation, 'create');
  assert.equal(b.objective, '补全智能体网络基础设施');
});

test('complete / clear 也是边界；clear 墓碑无 objective', () => {
  assert.equal(watchTaskBoundary(readerOf([goalChange(7, 'complete', '任务A')]), 7).operation, 'complete');
  const cleared = { seq: 8, type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'g1', revision: 2 }, clearedAt: 9 } };
  const b = watchTaskBoundary(readerOf([cleared]), 8);
  assert.equal(b.operation, 'clear');
  assert.equal(b.objective, undefined, 'clear 墓碑不带 goal ⇒ objective 必须缺省');
});

test('edit / pause / resume / block **不是**边界（仍是同一个任务）', () => {
  for (const op of ['edit', 'pause', 'resume', 'block']) {
    const read = readerOf([goalChange(100, op, '同一个任务')]);
    assert.equal(watchTaskBoundary(read, 100), null, op + ' 不该被当作任务边界');
  }
});

test('取**最近一次**边界（更早的边界已被它取代）', () => {
  const read = readerOf([
    goalChange(100, 'create', '旧任务'),
    goalChange(900, 'complete', '旧任务'),
    goalChange(950, 'create', '新任务'),
  ]);
  const b = watchTaskBoundary(read, 1000);
  assert.equal(b.seq, 950);
  assert.equal(b.objective, '新任务');
});

test('窗口外（lookback 之外）的边界不算', () => {
  const read = readerOf([goalChange(10, 'create', '很久以前')]);
  assert.equal(watchTaskBoundary(read, 10 + DEFAULT_TASK_LOOKBACK + 1), null);
  assert.notEqual(watchTaskBoundary(read, 10 + DEFAULT_TASK_LOOKBACK), null, '边界恰在窗口边缘时必须仍可见');
});

test('畸形事件不炸（data 非对象 / operation 非字符串 / 事件缺失）', () => {
  const read = readerOf([
    { seq: 1, type: 'goal/change', data: null },
    { seq: 2, type: 'goal/change', data: { operation: 42 } },
    { seq: 3, type: 'goal/change' },
    goalChange(4, 'create', '正常'),
  ]);
  const b = watchTaskBoundary(read, 4);
  assert.equal(b.seq, 4);
  assert.equal(b.operation, 'create');
});

// ---------- measureCarryOver：跨界残留 ----------

test('残留只数 seq < boundarySeq 的节点', () => {
  const nodes = [
    { seq: 10, tokens: 1000 },
    { seq: 20, tokens: 2000 },
    { seq: 30, tokens: 4000 },
  ];
  const c = measureCarryOver(nodes, 30, 7000);
  assert.equal(c.tokens, 3000, '边界之前的 1000 + 2000');
  assert.equal(c.ratio, 3000 / 7000);
});

test('残留测量：surfaceTokens<=0 或非有限 ⇒ ratio 0（不产生 NaN 污染裁决）', () => {
  assert.equal(measureCarryOver([{ seq: 1, tokens: 5 }], 9, 0).ratio, 0);
  assert.equal(measureCarryOver([{ seq: 1, tokens: 5 }], 9, Number.NaN).ratio, 0);
});

test('残留测量：非法/负 token 节点被跳过，不污染合计', () => {
  const nodes = [
    { seq: 1, tokens: 100 },
    { seq: 2, tokens: Number.NaN },
    { seq: 3, tokens: -50 },
  ];
  assert.equal(measureCarryOver(nodes, 9, 100).tokens, 100);
});

// ---------- decideTaskBoundaryHint：裁决（精度优先） ----------

const BOUNDARY = { seq: 950, operation: 'create', objective: '新任务' };

test('主人场景：跨任务 + 大量残留 ⇒ **即使占用只有 20%** 也投递（这就是「提早」）', () => {
  const hit = decideTaskBoundaryHint({
    boundary: BOUNDARY,
    carryOver: { tokens: 180_000, ratio: 0.9 },
    lastRemindedSeq: -1,
    minTokens: 30_000,
    minRatio: 0.5,
  });
  assert.notEqual(hit, null, '200K 占用（20%，远低于 50% 档）必须能被看见');
  assert.equal(hit.seq, 950);
});

test('去重：同一条边界只提醒一次（跨重启靠落盘状态）', () => {
  const base = { boundary: BOUNDARY, carryOver: { tokens: 180_000, ratio: 0.9 }, minTokens: 30_000, minRatio: 0.5 };
  assert.equal(decideTaskBoundaryHint({ ...base, lastRemindedSeq: 950 }), null, '同 seq 不得重复');
  assert.equal(decideTaskBoundaryHint({ ...base, lastRemindedSeq: 951 }), null, '更晚的已提醒 seq 亦压制');
  assert.notEqual(decideTaskBoundaryHint({ ...base, lastRemindedSeq: 949 }), null, '更新的边界必须仍能投递');
});

test('占比不足（当前任务自己已占多数）⇒ 不投递', () => {
  assert.equal(decideTaskBoundaryHint({
    boundary: BOUNDARY, carryOver: { tokens: 100_000, ratio: 0.2 },
    lastRemindedSeq: -1, minTokens: 30_000, minRatio: 0.5,
  }), null);
});

test('残留太小（压了也不省）⇒ 不投递', () => {
  assert.equal(decideTaskBoundaryHint({
    boundary: BOUNDARY, carryOver: { tokens: 10_000, ratio: 0.8 },
    lastRemindedSeq: -1, minTokens: 30_000, minRatio: 0.5,
  }), null);
});

test('无边界 ⇒ 恒不投递（对照组；判据有分辨力）', () => {
  assert.equal(decideTaskBoundaryHint({
    boundary: null, carryOver: { tokens: 900_000, ratio: 1 },
    lastRemindedSeq: -1, minTokens: 30_000, minRatio: 0.5,
  }), null, '残留再多、占用再高，没有边界就不该走这条通道');
});

test('配置异常（NaN / 越界）⇒ 安静不投（fail-safe 方向是安静，不是乱报）', () => {
  const base = { boundary: BOUNDARY, carryOver: { tokens: 180_000, ratio: 0.9 }, lastRemindedSeq: -1 };
  assert.equal(decideTaskBoundaryHint({ ...base, minTokens: Number.NaN, minRatio: 0.5 }), null);
  assert.equal(decideTaskBoundaryHint({ ...base, minTokens: 30_000, minRatio: Number.NaN }), null);
  assert.equal(decideTaskBoundaryHint({ ...base, minTokens: 30_000, minRatio: 1.5 }), null);
});

// ---------- buildTaskBoundaryHintText：文案带判断依据 ----------

test('文案说清「跨过什么边界 / 多少是残留 / 为何此刻压最划算」', () => {
  const text = buildTaskBoundaryHintText({
    boundary: BOUNDARY,
    carryOver: { tokens: 480_000, ratio: 0.91 },
    usedTokens: 527_000,
    contextWindow: 1_000_000,
  });
  assert.ok(text.includes('任务边界'), '必须点明是边界通道');
  assert.ok(text.includes('新任务开始'), '必须说明跨过的是哪类边界');
  assert.ok(text.includes('新任务'), '必须带出目标摘要，便于我认出是哪个任务');
  assert.ok(text.includes('480K'), '必须给出残留绝对量');
  assert.ok(text.includes('91%'), '必须给出残留占比');
  assert.ok(text.includes('527K'), '必须给出当前占用');
  assert.ok(text.includes('1000K'), '有窗口时给出容量');
  assert.ok(text.includes('/compact'), '必须给出动作');
});

test('文案：无 objective / 无窗口时不出现 undefined 与空括号', () => {
  const text = buildTaskBoundaryHintText({
    boundary: { seq: 5, operation: 'complete' },
    carryOver: { tokens: 60_000, ratio: 0.6 },
    usedTokens: 100_000,
  });
  assert.ok(!text.includes('undefined'), '缺省字段不得漏成 undefined');
  assert.ok(!text.includes('（）'), '无 objective 时不得留空括号');
  assert.ok(text.includes('上一个任务结束'));
});

test('文案：objective 过长被截断（提醒是插话，不搬运全文）', () => {
  const text = buildTaskBoundaryHintText({
    boundary: { seq: 5, operation: 'create', objective: 'x'.repeat(500) },
    carryOver: { tokens: 60_000, ratio: 0.6 },
    usedTokens: 100_000,
  });
  assert.ok(text.includes('…'), '超长目标必须截断');
  assert.ok(text.length < 700, '整条提醒必须有界');
});

// 2026-09-23 实测缺陷回归：首版把 objective 一律标成「上一任务」，于是**新任务开工**时的提醒
// 把新目标说成了上一个任务（真实投递里读到的正是这个反的句子）。
test('文案：objective 的定语按操作区分——create 是【新任务】，complete 是【刚结束的任务】', () => {
  const created = buildTaskBoundaryHintText({
    boundary: { seq: 5, operation: 'create', objective: '补全智能体网络基础设施' },
    carryOver: { tokens: 60_000, ratio: 0.6 },
    usedTokens: 100_000,
  });
  assert.ok(created.includes('新任务：「补全智能体网络基础设施」'), 'create 必须说「新任务」');
  assert.ok(!created.includes('上一任务'), 'create 不得说成上一任务（说反了）');

  const completed = buildTaskBoundaryHintText({
    boundary: { seq: 5, operation: 'complete', objective: '压缩提醒去死板' },
    carryOver: { tokens: 60_000, ratio: 0.6 },
    usedTokens: 100_000,
  });
  assert.ok(completed.includes('刚结束的任务：「压缩提醒去死板」'), 'complete 必须说「刚结束的任务」');
  assert.ok(!completed.includes('新任务：'), 'complete 不得说成新任务');
});
