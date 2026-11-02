/**
 * 梯级档位覆盖单测（2026-10-18）
 *
 * 现场：主人连问三次「压缩提醒怎么没来」。读数 `warnedStepByAgent[session]=50`、
 * `warnedAt=13:56:56` —— 50% 档报了，但 **400K（=40%）那一刻没报**。
 *
 * 根因：插件默认档位是 `[50, 65, 80, 90]`，**从 50 起跳**；而 `warnThreshold`
 * 默认 400000 在 1M 窗口下恰是 40%。⇒ 40%~50% 之间存在**无档位的空白带**，
 * 那一段里绝对阈值又被 `warnCooldownMs`（1h）压着 ⇒ 两条通道一起静音。
 *
 * 本文件用**已知会静音的档位表**当尸体样本，断言默认表不再有那个空白带。
 * 运行：`node --test tests/warn-ladder.test.mjs`（先构建 lib/）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextWarnStep } from '../lib/reminder-state.js'

/** 1M 窗口（与生产一致：contextWindow=1000000）。 */
const WINDOW = 1_000_000

test('尸体样本：旧默认表 [50,65,80,90] 在 400K（40%）处不报警 —— 证明该表有空白带', () => {
  // 这正是 2026-10-18 的现场判据：400K = 40%，旧表最低档 50% ⇒ 返回 null。
  const r = nextWarnStep([50, 65, 80, 90], 400_000, WINDOW, 0)
  assert.equal(r, null, '旧表在 40% 必须不报（这就是主人没收到提醒的机制）')
})

test('金标准：新默认表 [40,50,65,80,90] 在 400K（40%）处必须报 40 档', () => {
  const r = nextWarnStep([40, 50, 65, 80, 90], 400_000, WINDOW, 0)
  assert.notEqual(r, null, '400K 必须命中档位（否则绝对阈值再被冷却压住就彻底静音）')
  assert.equal(r.step, 40, '应命中 40 档，实际 ' + String(r === null ? 'null' : r.step))
  assert.equal(r.percent, 40)
})

test('金标准：刚过 40% 报 40；爬到 50% 再报 50（每档各一次，不重不漏）', () => {
  const pcts = [40, 50, 65, 80, 90]
  assert.equal(nextWarnStep(pcts, 401_000, WINDOW, 0).step, 40, '401K → 40 档')
  assert.equal(nextWarnStep(pcts, 499_000, WINDOW, 40), null, '499K 且已报 40 ⇒ 不重复')
  assert.equal(nextWarnStep(pcts, 501_000, WINDOW, 40).step, 50, '501K 且已报 40 ⇒ 报到 50')
})

test('金标准：40 档不误伤 —— 低于 40% 一律不报', () => {
  const pcts = [40, 50, 65, 80, 90]
  assert.equal(nextWarnStep(pcts, 399_000, WINDOW, 0), null, '399K 不该报')
  assert.equal(nextWarnStep(pcts, 100_000, WINDOW, 0), null, '10% 不该报')
})

test('窗口拿不到 ⇒ 返回 null（退回绝对阈值通道，不报错）', () => {
  const pcts = [40, 50, 65, 80, 90]
  assert.equal(nextWarnStep(pcts, 400_000, undefined, 0), null, '无窗口 ⇒ 不判档位')
  assert.equal(nextWarnStep(pcts, 400_000, 0, 0), null, '窗口 0 ⇒ 不判档位')
})
