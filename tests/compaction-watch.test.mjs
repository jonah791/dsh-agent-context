/**
 * compaction-watch 单测：压缩失败浮出水面（预防缺口修复 · 2026-09-11）
 *
 * 纪律（AGENTS.md 5.9 §2 / 5.15 §5）：防线必须有**尸体测试**——已知坏样本必须触发，
 * 好样本必须不误报。本文件的 5 组用例覆盖：坏样本触发、旧错误不报、窗口边界、
 * 空串防误报、无记录不报。
 *
 * 运行：node --test（由 `npm test` 在 tsc 构建后调用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestCompactionFailure, watchCompaction, DEFAULT_LOOKBACK } from '../lib/compaction-watch.js';

/** 构造一个按 seq 取事件的读取器。 */
function readerOf(events) {
  const bySeq = new Map(events.map((e, i) => [e.seq ?? i, e]));
  return (seq) => bySeq.get(seq);
}

/** 构造一条 compaction/end 事件。 */
function endEvent(seq, error) {
  const data = { compactionId: 'c1', sourceCommandId: 'alice-self-compact', turn: 1 };
  if (error !== undefined) data.error = error;
  return { seq, type: 'compaction/end', data };
}

test('尸体测试：最近一次 compaction/end 带错误 → 返回该失败与其 seq', () => {
  // 现场复刻：09-11 05:17:08 的真实失败（node 0 持有 system prompt）
  const raw = 'surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node';
  const read = readerOf([
    { seq: 1748, type: 'compaction/summary', data: { shadowedRange: { start: 14, end: 1728 } } },
    endEvent(1749, raw),
    { seq: 1750, type: 'turn/end', data: {} },
  ]);
  const failure = latestCompactionFailure(read, 1750);
  assert.notEqual(failure, null, '带错误的 compaction/end 必须被识别为失败');
  assert.equal(failure.seq, 1749);
  assert.equal(failure.error, raw, '错误全文必须原样带出，供取证');
});

test('不误报：最近一次 compaction/end 无错 → null（即使更早有过失败）', () => {
  const read = readerOf([
    endEvent(100, 'surface replace: node 0 holds the system prompt ...'),
    { seq: 101, type: 'turn/end', data: {} },
    endEvent(200), // 修复后的成功压缩：无 error 键
    { seq: 201, type: 'turn/end', data: {} },
  ]);
  assert.equal(
    latestCompactionFailure(read, 201),
    null,
    '最近一次成功即视为健康——报旧错误会制造狼来了，降低真告警敏感度',
  );
});

test('不误报：错误的 compaction/end 之后有新的成功压缩 → 清除告警', () => {
  const read = readerOf([
    endEvent(50, 'boom'),
    endEvent(60), // 重试成功
  ]);
  assert.equal(latestCompactionFailure(read, 60), null);
});

test('不误报：窗口内没有压缩记录 → null', () => {
  const read = readerOf([
    { seq: 10, type: 'user/message', data: {} },
    { seq: 11, type: 'turn/end', data: {} },
  ]);
  assert.equal(latestCompactionFailure(read, 11), null);
});

test('不误报：空字符串 / 非字符串 error → 不算失败', () => {
  const read = readerOf([
    endEvent(30, ''), // 空串：异常但无内容，不构成可取证失败
  ]);
  assert.equal(latestCompactionFailure(read, 30), null, '空 error 不得触发告警');

  const readObj = readerOf([{ seq: 31, type: 'compaction/end', data: { error: { message: 'x' } } }]);
  assert.equal(
    latestCompactionFailure(readObj, 31),
    null,
    '宿主契约里 error 是字符串（errorChain）；非字符串形态视为未知，不猜不报',
  );
});

test('有界回溯：错误落在窗口之外 → null（不无限扫全库）', () => {
  const read = readerOf([endEvent(1000, 'old failure')]);
  assert.equal(
    latestCompactionFailure(read, 1000 + DEFAULT_LOOKBACK + 1),
    null,
    '超出 lookback 的旧失败不再报——长会话不能被 O(n) 全库重扫',
  );
  // 同一条失败，在窗口内则应当被看到
  assert.notEqual(
    latestCompactionFailure(read, 1000 + DEFAULT_LOOKBACK, DEFAULT_LOOKBACK),
    null,
    '窗口边界内侧必须仍能命中',
  );
});

test('取最近一次：多个 compaction/end 时以 seq 最大者裁决', () => {
  const read = readerOf([
    endEvent(500), // 旧的成功
    endEvent(700, 'new failure'), // 新的失败 → 当前状态
  ]);
  const failure = latestCompactionFailure(read, 800);
  assert.notEqual(failure, null);
  assert.equal(failure.seq, 700);
  assert.equal(failure.error, 'new failure');
});

test('健壮性：读取器返回 null/非对象/缺字段时不崩', () => {
  const read = () => null;
  assert.equal(latestCompactionFailure(read, 100), null);
  const weird = (seq) => (seq === 100 ? { type: 'compaction/end' } : undefined);
  assert.equal(latestCompactionFailure(weird, 100), null, '缺 data 的事件不得抛错');
  const notObj = () => 42;
  assert.equal(latestCompactionFailure(notObj, 50), null, '非对象事件不得抛错');
});

// ────────────────────────────────────────────────────────────────────────────
// 2026-09-14 假告警事故：读时是结论、投递时已过期（事件流 7940 start / 7952 end(error)
// / 8092 start / 8108 end(成功)）。防线两条：飞行中不播报 + 投递前重验。
// ────────────────────────────────────────────────────────────────────────────

/** 构造一条 compaction/start 事件。 */
function startEvent(seq, compactionId = 'c1') {
  return { seq, type: 'compaction/start', data: { compactionId, sourceCommandId: 'alice-self-compact', turn: 1 } };
}

test('飞行中：start 之后还没有 end → inFlight=true（此刻的「最近失败」不得播报）', () => {
  const read = readerOf([
    startEvent(7940, 'f1'),
    endEvent(7952, 'guard refused'),
    startEvent(8092, 'f2'),
  ]);
  const w = watchCompaction(read, 8092);
  assert.equal(w.inFlight, true, 'start 晚于最近 end = 压缩事务在飞行中，结论未定');
  assert.equal(w.endSeq, 7952);
  assert.notEqual(w.failure, null, '「最近一次已结束的压缩」确实是失败的——这正是旧版会播报的输入');
  assert.equal(w.failure.seq, 7952);
});

test('投递前重验：飞行的那次成功落定 → failure 变 null（过期告警必须作废）', () => {
  const read = readerOf([
    startEvent(7940, 'f1'),
    endEvent(7952, 'guard refused'),
    startEvent(8092, 'f2'),
    endEvent(8108), // 重试成功：无 error 键
  ]);
  const w = watchCompaction(read, 8108);
  assert.equal(w.inFlight, false, 'end 晚于 start = 事务已落定');
  assert.equal(w.endSeq, 8108);
  assert.equal(w.failure, null, '已有更晚的成功 end，旧失败告警必须被抑制（否则制造狼来了）');
});

test('飞行中重验：新的失败落定 → failure 指向新 seq（下一轮按新结论播报）', () => {
  const read = readerOf([endEvent(7952, 'old'), startEvent(8092, 'f2'), endEvent(8120, 'new')]);
  const w = watchCompaction(read, 8120);
  assert.equal(w.inFlight, false);
  assert.equal(w.failure.seq, 8120, '重验口径同时覆盖「换成新失败」——旧 seq 不再匹配即作废');
  assert.equal(w.failure.error, 'new');
});

test('兼容：latestCompactionFailure 仍是「最近一次已结束」的薄包装', () => {
  const read = readerOf([startEvent(70, 'x'), endEvent(80, 'boom'), startEvent(90, 'y')]);
  const failure = latestCompactionFailure(read, 90);
  assert.notEqual(failure, null);
  assert.equal(failure.seq, 80, '包装层语义不变：仍只报已结束的最近结论');
  assert.equal(watchCompaction(read, 90).inFlight, true, '同一快照里同时暴露飞行状态');
});

test('健壮性：只有 start 没有 end（窗口内从未压缩成功过）→ inFlight=true 且 failure=null', () => {
  const w = watchCompaction(readerOf([startEvent(30, 'only')]), 30);
  assert.equal(w.inFlight, true);
  assert.equal(w.endSeq, null);
  assert.equal(w.failure, null);
});
