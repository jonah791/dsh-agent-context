/**
 * reminderCheckpoint 单测（判定点：turn/end 兜底 + step/end 主路径）
 *
 * 为什么有这条判据（2026-10-15 主人指令）：「不能是下一轮，而是**下一个工具调用**」——
 * 判定点必须细到 step 级（一次完整思考 + 工具调用链 = 官方口径的真实工作单元），
 * 否则由 next-step 投递的插话要等到下一轮才出现。
 *
 * 纪律：事件类型字符串取真源（harness 口径 `turn/end` / `step/end`；旁证：
 * dsh-agent-skill-forge 在 `ev.type === 'step/end'` 上计数，dsh-agent-self-rewrite
 * 的事件序列测试列出 turn/start · step/start · assistant/attempt · step/end · turn/end）。
 * 尸体样本：近似拼写（下划线 / 驼峰 / 大小写 / 前后空格）必须一律判 null——
 * 证明判据不是「含 turn 或 step 就通过」。
 *
 * 运行：`node --test tests/checkpoint.test.mjs`（先 `npm run build` 产出 lib/）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reminderCheckpoint } from '../lib/reminder-state.js'

test('step/end 是判定点（主人 2026-10-15：插到下一个工具调用之前）', () => {
  assert.equal(reminderCheckpoint('step/end'), 'step')
})

test('turn/end 仍是判定点（纯文本轮兜底）', () => {
  assert.equal(reminderCheckpoint('turn/end'), 'turn')
})

test('其他会话事件不是判定点', () => {
  const others = [
    'turn/start',
    'step/start',
    'assistant/message',
    'assistant/attempt',
    'tool/result',
    'compaction/end',
    'agent/inbox/spliced',
    '',
  ]
  for (const t of others) assert.equal(reminderCheckpoint(t), null, t)
})

test('undefined 不抛且判 null（fail-safe：形状异常不炸宿主）', () => {
  assert.equal(reminderCheckpoint(undefined), null)
})

test('尸体样本：近似拼写一律不通过', () => {
  const corpses = [
    'turn_end',
    'stepEnd',
    'STEP/END',
    'Turn/End',
    'turn/end ',
    ' step/end',
    'turn/end\n',
    'step',
  ]
  for (const t of corpses) assert.equal(reminderCheckpoint(t), null, JSON.stringify(t))
})
