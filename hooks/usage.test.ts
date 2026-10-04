import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_PRICES,
  addUsage,
  aggregate,
  branchDirName,
  buildPrices,
  costUsd,
  formatTokens,
  newSessionFile,
  priceFor,
  relativeTime,
  sharePct,
  shortModel,
} from './usage'

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
})

test('cost uses input, output and both cache rates', () => {
  const { price } = priceFor('claude-opus-5-5', DEFAULT_PRICES)
  // 1M of each: 4 + 20 + 0.2 + 5
  expect(Math.abs(costUsd(usage(1e6, 1e6, 1e6, 1e6), price) - 29.2) < 1e-6).toBe(true)
})

test('longest prefix wins and unknown models are flagged', () => {
  expect(priceFor('claude-opus-5-5', DEFAULT_PRICES).price.in).toBe(4)
  expect(priceFor('claude-opus-5', DEFAULT_PRICES).price.in).toBe(5)
  expect(priceFor('claude-sonnet-4-6', DEFAULT_PRICES).price.in).toBe(3)
  expect(priceFor('mystery-model', DEFAULT_PRICES).isKnown).toBe(false)
})

test('override replaces a prefix and keeps the rest', () => {
  const table = buildPrices('{"claude-haiku-4": {"in": 2, "out": 9}}')
  expect(priceFor('claude-haiku-4-5', table).price).toEqual({ in: 2, out: 9, cacheRead: 0.2, cacheWrite: 2.5 })
  expect(priceFor('claude-opus-5', table).price.in).toBe(5)
})

test('bad override names the option', () => {
  expect(() => buildPrices('{oops')).toThrow(/"prices" is not valid JSON/)
  expect(() => buildPrices('{"x": {"in": 1}}')).toThrow(/needs numeric/)
})

test('addUsage accumulates per agent and model', () => {
  let file = newSessionFile('s1', 'main', 0)
  file = addUsage(file, { agent: 'main', model: 'claude-sonnet-5-5', usage: usage(1000, 100) }, DEFAULT_PRICES, 1)
  file = addUsage(file, { agent: 'main', model: 'claude-sonnet-5-5', usage: usage(500, 50, 200, 10) }, DEFAULT_PRICES, 2)
  file = addUsage(file, { agent: 'Explore', model: 'claude-haiku-4-5', usage: usage(10, 5) }, DEFAULT_PRICES, 3)
  const row = file.rows['main|claude-sonnet-5-5']
  expect(row.requests).toBe(2)
  expect(row.input).toBe(1500)
  expect(row.cacheRead).toBe(200)
  expect(Object.keys(file.rows).length).toBe(2)
  expect(file.updatedAt).toBe(3)
})

test('aggregate groups two sessions by model, agent and session', () => {
  let a = newSessionFile('a', 'main', 0)
  a = addUsage(a, { agent: 'main', model: 'claude-sonnet-5-5', usage: usage(1e6, 0) }, DEFAULT_PRICES, 10)
  let b = newSessionFile('b', 'main', 0)
  b = addUsage(b, { agent: 'main', model: 'claude-sonnet-5-5', usage: usage(1e6, 0) }, DEFAULT_PRICES, 20)
  b = addUsage(b, { agent: 'Explore', model: 'claude-haiku-4-5', usage: usage(1e6, 0) }, DEFAULT_PRICES, 20)
  const view = aggregate([a, b], 'main', 'b')
  expect(Math.abs(view.totalUsd - 5) < 1e-6).toBe(true)
  const sonnetUsd = view.byModel.find(r => r.model === 'claude-sonnet-5-5')?.usd ?? 0
  expect(Math.abs(sonnetUsd - 4) < 1e-6).toBe(true)
  expect(view.byAgent.map(r => r.agent).sort()).toEqual(['Explore', 'main'])
  expect(view.sessions.map(s => s.sessionId)).toEqual(['b', 'a'])
})

test('branch names are safe directory names', () => {
  expect(branchDirName('feat/x')).toBe('feat%2Fx')
  expect(formatTokens(12_340)).toBe('12.3k')
  expect(formatTokens(1_200_000)).toBe('1.2M')
})

test('shortModel strips the claude- prefix only', () => {
  expect(shortModel('claude-sonnet-5-5')).toBe('sonnet-5-5')
  expect(shortModel('gpt-x')).toBe('gpt-x')
})

test('relativeTime switches unit at 1m, 1h and 1d', () => {
  const now = 10 * 86_400_000
  const ago = (ms: number) => relativeTime(now - ms, now)
  expect(ago(59_000)).toBe('just now')
  expect(ago(60_000)).toBe('1m ago')
  expect(ago(59 * 60_000)).toBe('59m ago')
  expect(ago(60 * 60_000)).toBe('1h ago')
  expect(ago(23 * 3_600_000)).toBe('23h ago')
  expect(ago(24 * 3_600_000)).toBe('1d ago')
})

test('sharePct rounds and survives a zero total', () => {
  expect(sharePct(1.432, 2.58)).toBe('56%')
  expect(sharePct(0, 0)).toBe('0%')
})
