/**
 * 提醒状态持久化单测（2026-09-14）
 *
 * 现场复刻：`compaction/end` seq=9088（turn 78 失败）在 09:32:45 重启后**被重复播报**——
 * 去重状态只在内存。本文件的第 2 个用例就是那条事故：从磁盘加载 state 后，
 * **同一 seq 不得再播**（跨重启有效），而**更新的 seq 仍必须播**。
 *
 * 运行：`node --test tests/*.test.mjs`（先 `npm run build` 产出 lib/）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_REMINDER_STATE,
  nextWarnStep,
  parseReminderState,
  reminderStatePath,
  serializeReminderState,
  shouldNotifyFailure,
  shouldWarn,
  withFailureNotified,
  withWarned,
  withWarnedStep,
  withoutFailure,
} from '../lib/reminder-state.js';

const SESSION = 'session-879c4ae1-b33e-43de-91d3-a968a6af6f2c';

test('fail-safe：坏数据一律回落空状态（解析绝不抛）', () => {
  for (const raw of [null, undefined, 42, 'x', [], { failureSeqByAgent: 'x' }, { fearureSeqByAgent: {} }]) {
    const state = parseReminderState(raw);
    assert.equal(typeof state.failureSeqByAgent, 'object');
    assert.equal(typeof state.warnedAtByAgent, 'object');
    assert.deepEqual(state.failureSeqByAgent, {}, `raw=${JSON.stringify(raw)} 不得产出条目`);
  }
});

test('尸体测试：同一失败 seq 跨重启不再重复播报（事故 9088）', () => {
  // 重启后从磁盘加载的状态（上一实例已播报过 9088）
  const loaded = parseReminderState({ failureSeqByAgent: { [SESSION]: 9088 }, warnedAtByAgent: {} });
  assert.equal(
    shouldNotifyFailure(loaded, SESSION, 9088),
    false,
    '已播报过的 seq 必须被抑制（否则每次重启都喊一次「上一次压缩失败」= 狼来了）',
  );
  assert.equal(shouldNotifyFailure(loaded, SESSION, 9200), true, '更新的失败仍必须播报');
  assert.equal(shouldNotifyFailure(EMPTY_REMINDER_STATE, SESSION, 9088), true, '首次必须播报');
  assert.equal(shouldNotifyFailure(loaded, 'other-agent', 9088), true, '按 agent 分键：别的会话不受影响');
});

test('健康后清除记录 → 将来的同 seq 不会被误吞（语义：清除只针对已恢复的情况）', () => {
  const loaded = parseReminderState({ failureSeqByAgent: { [SESSION]: 9088 } });
  const cleared = withoutFailure(loaded, SESSION);
  assert.equal(shouldNotifyFailure(cleared, SESSION, 9088), true);
  assert.equal(withoutFailure(cleared, SESSION), cleared, '无记录时返回同一对象（幂等）');
});

test('冷却跨重启有效：warnedAt 落盘后同窗口内不再提醒', () => {
  const now = Date.parse('2026-09-14T09:35:00+08:00');
  const loaded = parseReminderState({ warnedAtByAgent: { [SESSION]: now - 60_000 } });
  assert.equal(shouldWarn(loaded, SESSION, now, 3_600_000), false, '重启不该让冷却归零');
  assert.equal(shouldWarn(loaded, SESSION, now + 3_600_000, 3_600_000), true, '冷却过后放行');
  assert.equal(shouldWarn(EMPTY_REMINDER_STATE, SESSION, now, 3_600_000), true, '无记录 → 放行');
});

test('不可变更新：with* 返回新对象，不改原状态（便于「先写状态再投递」）', () => {
  const base = EMPTY_REMINDER_STATE;
  const a = withFailureNotified(base, SESSION, 9088);
  const b = withWarned(a, SESSION, 1789349700000);
  assert.equal(base.failureSeqByAgent[SESSION], undefined, '原状态不得被改');
  assert.equal(b.failureSeqByAgent[SESSION], 9088);
  assert.equal(b.warnedAtByAgent[SESSION], 1789349700000);
  assert.equal(a.warnedAtByAgent[SESSION], undefined);
});

test('序列化往返：写盘 → 读回 → 语义不变', () => {
  const state = withWarned(withFailureNotified(EMPTY_REMINDER_STATE, SESSION, 9088), SESSION, 1789349700000);
  const line = serializeReminderState(state);
  assert.equal(line.includes('\n'), false, '单行 JSON（便于人读/断言）');
  const back = parseReminderState(JSON.parse(line));
  assert.deepEqual(back, state);
});

test('状态文件路径：不产生双分隔符；带尾分隔符的 home 也正确', () => {
  assert.equal(reminderStatePath('E:/alice/.dsh'), 'E:/alice/.dsh/context-reminder-state.json');
  assert.equal(reminderStatePath('E:/alice/.dsh/'), 'E:/alice/.dsh/context-reminder-state.json');
  assert.equal(reminderStatePath('C:\\x\\.dsh\\'), 'C:\\x\\.dsh\\context-reminder-state.json');
});

// ── 2026-09-22 主人指令：「上下文感知要走插话形式」───────────────────────
// 现场：GUI 显示「已用 57% ~568K / 1M」，而旧通道（500K 阈值 + 一小时冷却）被冷却压住，
// 感知到不了我这儿，只能等主人手动插一句。⇒ 改为**随用量递进的档位**，每跨一档插一次。

const LADDER = [50, 65, 80, 90];
const WINDOW = 1_000_000;

test('梯级插话：跨过 50% 报 50 档；同一档**不重复报**（去重靠持久化的已报最高档）', () => {
  assert.deepEqual(nextWarnStep(LADDER, 510_000, WINDOW, 0), { step: 50, percent: 51 });
  assert.equal(nextWarnStep(LADDER, 510_000, WINDOW, 50), null, '同一档不得重复插话');
  assert.equal(nextWarnStep(LADDER, 490_000, WINDOW, 0), null, '未跨档不报');
});

test('★ 现场复刻：主人看到的 57%（568K/1M）在这一版下**会**插话（旧版被 500K 阈值+冷却压住）', () => {
  const step = nextWarnStep(LADDER, 568_000, WINDOW, 0);
  assert.deepEqual(step, { step: 50, percent: 57 }, '必须报，且百分比要与 GUI 一致');
  // 而旧通道此刻**已被冷却压住**（same session warned 30 分钟前）——这就是「感知到不了」的根因
  const now = 1_790_067_000_000;
  const warned = parseReminderState({ warnedAtByAgent: { [SESSION]: now - 30 * 60_000 } });
  assert.equal(shouldWarn(warned, SESSION, now, 3_600_000), false, '旧通道在冷却里（30 分钟前刚报过）');
});

test('梯级递进：用量爬到 66% ⇒ 报 65 档（跨档即报，不受一小时冷却限制）', () => {
  assert.deepEqual(nextWarnStep(LADDER, 660_000, WINDOW, 50), { step: 65, percent: 66 });
  assert.deepEqual(nextWarnStep(LADDER, 910_000, WINDOW, 65), { step: 90, percent: 91 });
});

test('跳档：一次跨过两档 ⇒ 报最高的那一档（不按顺序补报，避免刷屏）', () => {
  assert.deepEqual(nextWarnStep(LADDER, 820_000, WINDOW, 50), { step: 80, percent: 82 });
});

test('对照组：窗口未知 / 占用量非法 / 档位为空 ⇒ 一律返回 null（退回旧通道，不瞎报）', () => {
  assert.equal(nextWarnStep(LADDER, 568_000, undefined, 0), null, '拿不到窗口就别按百分比判');
  assert.equal(nextWarnStep(LADDER, Number.NaN, WINDOW, 0), null);
  assert.equal(nextWarnStep(LADDER, -1, WINDOW, 0), null);
  assert.equal(nextWarnStep([], 568_000, WINDOW, 0), null);
  assert.equal(nextWarnStep(LADDER, 568_000, 0, 0), null, '窗口 0 是无效值');
});

test('withWarnedStep 只升不降，且不可变', () => {
  const a = withWarnedStep(EMPTY_REMINDER_STATE, SESSION, 50);
  const b = withWarnedStep(a, SESSION, 65);
  assert.equal(EMPTY_REMINDER_STATE.warnedStepByAgent[SESSION], undefined, '原状态不得被改');
  assert.equal(a.warnedStepByAgent[SESSION], 50);
  assert.equal(b.warnedStepByAgent[SESSION], 65);
  assert.equal(withWarnedStep(b, SESSION, 50), b, '回退档位必须是 no-op（返回同一对象）');
});

test('新字段进序列化往返；**旧状态文件（无该字段）读回来是空记录**，不炸', () => {
  const state = withWarnedStep(withWarned(EMPTY_REMINDER_STATE, SESSION, 1789349700000), SESSION, 65);
  assert.deepEqual(parseReminderState(JSON.parse(serializeReminderState(state))), state);
  const legacy = parseReminderState({ failureSeqByAgent: {}, warnedAtByAgent: { [SESSION]: 1 } });
  assert.deepEqual(legacy.warnedStepByAgent, {}, '旧文件缺字段 ⇒ 空记录（fail-safe）');
  assert.equal(legacy.warnedAtByAgent[SESSION], 1, '旧字段照常读出来');
});
