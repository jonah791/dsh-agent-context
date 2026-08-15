/**
 * format.ts 纯函数单测（Node ≥22.18 原生 TS 支持，node --test tests/）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatReportText, formatTokens } from '../src/format.ts'
import type { ContextReport } from '../src/index.ts'

// ---------- formatTokens ----------

test('formatTokens：千以内原样', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(42), '42')
  assert.equal(formatTokens(999), '999')
})

test('formatTokens：k 档一位小数', () => {
  assert.equal(formatTokens(1000), '1.0k')
  assert.equal(formatTokens(1234), '1.2k')
  assert.equal(formatTokens(460634), '460.6k')
})

test('formatTokens：M 档两位小数', () => {
  assert.equal(formatTokens(1_000_000), '1.00M')
  assert.equal(formatTokens(812_345_678), '812.35M')
})

test('formatTokens：非法输入 → ?', () => {
  assert.equal(formatTokens(NaN), '?')
  assert.equal(formatTokens(Infinity), '?')
  assert.equal(formatTokens(-5), '?')
})

// ---------- formatReportText ----------

const base: ContextReport = {
  sessionId: 's1',
  asOfSeq: 1000,
  logRevision: 1000,
  totalTokens: 50_000,
  surfaceTokens: 48_000,
  surfaceMessages: 1024,
  usage: { uncachedInputTokens: 300_000, outputTokens: 100_000, cacheReadTokens: 400_000, cacheWriteTokens: 12_000 },
  usageTotal: 812_000,
  breakdown: { systemTokens: 2100, toolsTokens: 18_400, messageTokens: 48_000 },
}

test('formatReportText：完整字段（含窗口与投影）', () => {
  const text = formatReportText({
    ...base,
    pressureTokens: 45_000,
    projectedTokens: 46_100,
    contextWindow: 131_072,
  })
  const lines = text.split('\n')
  assert.equal(lines[0], '上下文状态（事件 1000）')
  assert.equal(lines[1], '占用：46.1k / 131.1k (35%)')
  assert.equal(lines[2], '最近请求 prompt：45.0k')
  assert.equal(lines[3], 'surface：48.0k（1,024 条消息）')
  assert.ok(lines[4].startsWith('已花费（累计）：812.0k'))
  assert.ok(lines[4].includes('缓存读 400.0k'))
  assert.ok(lines[5].startsWith('组成（启发式）：system 2.1k / tools 18.4k / messages 48.0k'))
})

test('formatReportText：无窗口 → 估计占用行', () => {
  const text = formatReportText(base)
  const lines = text.split('\n')
  assert.equal(lines[1], '占用（估计）：50.0k')
  assert.ok(!text.includes('%'))
})

test('formatReportText：无 pressure 投影 → 无 prompt 行', () => {
  const text = formatReportText({ ...base, projectedTokens: undefined })
  assert.ok(!text.includes('最近请求'))
})

test('formatReportText：空 usage → 全零', () => {
  const text = formatReportText({
    ...base,
    usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    usageTotal: 0,
  })
  assert.ok(text.includes('已花费（累计）：0 = 未缓存输入 0 + 缓存读 0 + 缓存写 0 + 输出 0'))
})