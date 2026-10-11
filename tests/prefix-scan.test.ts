/**
 * prefix-scan.ts 纯函数单测：前缀分叉探测（2026-10-11）。
 *
 * 可证伪性：本套件含 **intact 组与 diverged 组两侧样本**——
 * 若实现退化成「恒返回 intact」（或恒定共同前缀），diverged 组会红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPrefix, hitSpanRatio, prefixRetention, sharedPrefixLength } from '../src/prefix-scan.ts'

// ---------- sharedPrefixLength ----------

test('纯追加 ⇒ 共同前缀 = 旧长度，判 intact', () => {
  const prev = [1, 2, 3]
  const next = [1, 2, 3, 4, 5]
  const shared = sharedPrefixLength(prev, next)
  assert.equal(shared, 3)
  assert.equal(classifyPrefix(prev.length, shared), 'intact')
  assert.equal(prefixRetention(prev.length, shared), 1)
})

test('两侧完全相同 ⇒ intact（等于没有变化）', () => {
  const a = [5, 6, 7]
  const next = [...a]
  assert.equal(sharedPrefixLength(a, next), 3)
  assert.equal(classifyPrefix(a.length, 3), 'intact')
})

test('尸体样本 · 中段被替换（surfaceOp replace 的典型形态）⇒ 断裂点即分叉点', () => {
  const prev = [10, 11, 12, 13, 14]
  const next = [10, 11, 99, 13, 14]
  const shared = sharedPrefixLength(prev, next)
  assert.equal(shared, 2, '分叉必须落在第 3 个节点（索引 2）')
  assert.equal(classifyPrefix(prev.length, shared), 'diverged')
  assert.equal(prefixRetention(prev.length, shared), 0.4)
  assert.equal(hitSpanRatio(next.length, shared), 0.4, '本次 5 个节点里只有前 2 个在共同前缀内')
})

test('尸体样本 · 整体替换（压缩 checkpoint 形态）⇒ 共同前缀 0', () => {
  const prev = [1, 2, 3, 4, 5, 6]
  const next = [77]
  assert.equal(sharedPrefixLength(prev, next), 0)
  assert.equal(classifyPrefix(prev.length, 0), 'diverged')
  assert.equal(hitSpanRatio(next.length, 0), 0)
})

test('尾部截断 ⇒ 判 diverged（旧节点未被保留），但共同前缀本身完好', () => {
  const prev = [1, 2, 3, 4]
  const next = [1, 2]
  const shared = sharedPrefixLength(prev, next)
  assert.equal(shared, 2)
  assert.equal(classifyPrefix(prev.length, shared), 'diverged')
  // 陷阱文档化：diverged 不等于「缓存受损」——本次请求的前 2 个节点仍在共同前缀内
  assert.equal(hitSpanRatio(next.length, shared), 1, '本次请求全部落在共同前缀内 ⇒ 全部可命中')
})

test('空数组边界', () => {
  assert.equal(sharedPrefixLength([], [1, 2]), 0)
  assert.equal(sharedPrefixLength([1, 2], []), 0)
  assert.equal(sharedPrefixLength([], []), 0)
})

// ---------- prefixRetention / hitSpanRatio ----------

test('prefixRetention：比例正确；无基准返回 null', () => {
  assert.equal(prefixRetention(4, 3), 0.75)
  assert.equal(prefixRetention(4, 4), 1)
  assert.equal(prefixRetention(0, 0), null)
})

test('hitSpanRatio：比例正确；空本次返回 null', () => {
  assert.equal(hitSpanRatio(8, 6), 0.75)
  assert.equal(hitSpanRatio(0, 0), null)
})

test('单侧为空时的组合不抛（两条派生量各自独立处理退化）', () => {
  const shared = sharedPrefixLength([1, 2, 3], [])
  assert.equal(shared, 0)
  assert.equal(prefixRetention(3, shared), 0)
  assert.equal(hitSpanRatio(0, shared), null)
})
