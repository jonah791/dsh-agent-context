/**
 * 剪枝档位与内容指纹 离线单测（2026-09-20，移植自 tamaratran/fast-jev-compaction）
 *
 * 判据：① 三档字符账单调（L1 最保守、L3 最激进）② 指纹能从内容读出「重跑工具能否替代」的信号
 * ③ 建议档位与信号一致 ④ L1 预算 = 插件旧默认（向后兼容的锚点）
 *
 * 运行：先 npm run build（tsc），再 node --test tests/prune-plan.test.mjs
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inspectContent,
  planLevels,
  suggestLevel,
  PRUNE_LEVELS,
  LEVEL_ORDER,
  NOTE_OVERHEAD_CHARS,
} from '../lib/prune-plan.js'

describe('inspectContent · 内容指纹（「重跑工具能否替代」的代理）', () => {
  test('报错栈 ⇒ hasError + irreplaceable（重跑未必复现同一现场）', () => {
    const f = inspectContent('Traceback (most recent call last):\n  File "x.py", line 3\nValueError: bad')
    assert.equal(f.hasError, true)
    assert.equal(f.irreplaceable, true)
    assert.ok(f.flags.includes('error'))
  })

  test('唯一 ID/哈希 ⇒ irreplaceable（重取拿不到同一个值）', () => {
    const f = inspectContent('commit 3f2a9c1d8e4b7a6f5c3d2e1b0a9f8e7d6c5b4a3f')
    assert.equal(f.hasUniqueIds, true)
    assert.equal(f.irreplaceable, true)
  })

  test('同质大块（重复行多）⇒ homogeneous 且**不**不可重取（可放心激进剪）', () => {
    const lines = Array.from({ length: 40 }, (_v, i) => `row ${i % 3} value`)
    const f = inspectContent(lines.join('\n'))
    assert.equal(f.homogeneous, true)
    assert.equal(f.irreplaceable, false)
    assert.equal(suggestLevel(f), 'L3-note-only')
  })

  test('非大块的路径 ⇒ irreplaceable（要保头尾轮廓：重取要再读一次文件）', () => {
    const f = inspectContent('read E:\\alice\\AGENTS.md\nok 65536 chars')
    assert.equal(f.hasPaths, true)
    assert.equal(f.homogeneous, false)
    assert.equal(f.irreplaceable, true)
    assert.equal(suggestLevel(f), 'L1-head-tail')
  })

  test('命令行 ⇒ hasCommands 信号（结论性内容，但不单独构成不可重取）', () => {
    const f = inspectContent('$ npm run build\nok')
    assert.equal(f.hasCommands, true)
    assert.equal(f.irreplaceable, false)
    assert.equal(suggestLevel(f), 'L2-heavy')
  })

  test('干净短文 ⇒ 无信号、不不可重取', () => {
    const f = inspectContent('done')
    assert.equal(f.flags.length, 0)
    assert.equal(f.irreplaceable, false)
    assert.equal(suggestLevel(f), 'L2-heavy')
  })
})

describe('planLevels · 三档字符账（渐进降级）', () => {
  test('三档齐全且顺序固定（L1 → L2 → L3）', () => {
    const plans = planLevels(100000)
    assert.deepEqual(plans.map((p) => p.level), [...LEVEL_ORDER])
  })

  test('省下的字符逐档递增（L1 最保守、L3 最激进）—— 渐进降级的核心契约', () => {
    const [l1, l2, l3] = planLevels(100000)
    assert.ok(l1.savedChars < l2.savedChars, 'L2 应比 L1 省得多')
    assert.ok(l2.savedChars < l3.savedChars, 'L3 应比 L2 省得多')
  })

  test('L3 的 charsAfter = 注记开销（只留一行）', () => {
    const l3 = planLevels(100000).find((p) => p.level === 'L3-note-only')
    assert.equal(l3.charsAfter, NOTE_OVERHEAD_CHARS)
  })

  test('内容小于档位预算 ⇒ 该档无效（effective=false，且不虚报负数节省）', () => {
    for (const p of planLevels(100)) {
      assert.equal(p.savedChars, 0)
      assert.equal(p.effective, false)
      assert.equal(p.charsAfter, 100)
    }
  })

  test('L1 预算 = 4096+1024（与插件旧默认一致 —— 向后兼容的锚点）', () => {
    assert.equal(PRUNE_LEVELS['L1-head-tail'].headChars, 4096)
    assert.equal(PRUNE_LEVELS['L1-head-tail'].tailChars, 1024)
  })
})
