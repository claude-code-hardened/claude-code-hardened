import { describe, expect, test } from 'bun:test'
import {
  createByteBudgetCache,
  DEFAULT_MAX_ITEM_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  type ByteBudgetCache,
} from '../cacheBudget'

type SimpleCache = ByteBudgetCache<string, string>

function fixtureCache(opts: {
  maxTotalBytes: number
  maxItemBytes: number
  sizes?: Record<string, number>
}): SimpleCache {
  return createByteBudgetCache<string, string>({
    maxTotalBytes: opts.maxTotalBytes,
    maxItemBytes: opts.maxItemBytes,
    // Default estimate: string length. Per-key overrides let tests dial in
    // exact budgets without modifying the values.
    estimateSize: (value, key) => opts.sizes?.[key] ?? value.length,
  })
}

describe('createByteBudgetCache', () => {
  test('default budgets are 8 MiB total and 1 MiB per item', () => {
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(8 * 1024 * 1024)
    expect(DEFAULT_MAX_ITEM_BYTES).toBe(1024 * 1024)
  })

  test('get/set/has/delete/clear behave like a Map', () => {
    const cache = fixtureCache({ maxTotalBytes: 1024, maxItemBytes: 512 })
    expect(cache.size).toBe(0)
    expect(cache.has('a')).toBe(false)
    expect(cache.set('a', 'hello')).toBe(true)
    expect(cache.has('a')).toBe(true)
    expect(cache.get('a')).toBe('hello')
    expect(cache.bytes).toBe('hello'.length)
    expect(cache.delete('a')).toBe(true)
    expect(cache.has('a')).toBe(false)
    expect(cache.size).toBe(0)
    cache.set('b', 'xxx')
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })

  test('hit returns the identical value reference, no recompute', () => {
    const cache = createByteBudgetCache<string, number[]>({
      estimateSize: values => values.length * 8,
    })
    const value = [1, 2, 3]
    cache.set('k', value)
    expect(cache.get('k')).toBe(value)
    expect(cache.get('k')).toBe(value)
  })

  test('bytes track the estimateSize sum per key', () => {
    const cache = fixtureCache({
      maxTotalBytes: 500,
      maxItemBytes: 200,
      sizes: { a: 50, b: 30 },
    })
    cache.set('a', 'a')
    expect(cache.bytes).toBe(50)
    cache.set('b', 'b')
    expect(cache.bytes).toBe(80)
    // Overwriting the same key replaces its accounting.
    cache.set('a', 'a')
    expect(cache.bytes).toBe(80)
    cache.delete('a')
    expect(cache.bytes).toBe(30)
  })

  test('eviction order is LRU: get() promotes, overflow evicts oldest', () => {
    // Entries cost 144 bytes; the budget fits exactly two.
    const cache = fixtureCache({ maxTotalBytes: 288, maxItemBytes: 144 })
    const value = 'x'.repeat(144)
    cache.set('k1', value)
    cache.set('k2', value)
    expect(cache.size).toBe(2)

    // Touching k1 makes it most-recently-used; k2 becomes the LRU entry.
    expect(cache.get('k1')).toBe(value)
    cache.set('k3', value)

    expect(cache.has('k1')).toBe(true)
    expect(cache.has('k2')).toBe(false)
    expect(cache.has('k3')).toBe(true)
    expect(cache.bytes).toBe(288)
  })

  test('values above the per-item limit are not cached', () => {
    const cache = fixtureCache({
      maxTotalBytes: 8 * 1024 * 1024,
      maxItemBytes: 100,
      sizes: { big: 101 },
    })
    expect(cache.set('big', 'payload')).toBe(false)
    expect(cache.has('big')).toBe(false)
    expect(cache.get('big')).toBeUndefined()
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)

    // Exactly at the limit still counts as within (strictly greater rejects).
    cache.set('edge', 'x'.repeat(100))
    expect(cache.has('edge')).toBe(true)
    expect(cache.bytes).toBe(100)
  })

  test('per-item limit is clamped to the total budget', () => {
    const cache = fixtureCache({ maxTotalBytes: 50, maxItemBytes: 1000 })
    expect(cache.set('huge', 'x'.repeat(51))).toBe(false)
    expect(cache.set('fits', 'x'.repeat(50))).toBe(true)
    expect(cache.bytes).toBe(50)
  })

  test('delete frees budget for new entries', () => {
    const cache = fixtureCache({ maxTotalBytes: 200, maxItemBytes: 200 })
    cache.set('a', 'x'.repeat(100))
    cache.set('b', 'x'.repeat(100))
    expect(cache.bytes).toBe(200)
    cache.delete('a')
    expect(cache.has('a')).toBe(false)
    // Fits now without evicting 'b' — delete actually released the bytes.
    expect(cache.set('c', 'x'.repeat(100))).toBe(true)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.bytes).toBe(200)
  })

  test('clear() resets eviction accounting, capacity reusable', () => {
    const cache = fixtureCache({ maxTotalBytes: 200, maxItemBytes: 200 })
    for (let i = 0; i < 4; i++) {
      cache.set(`k${i}`, 'x'.repeat(100))
    }
    // Four entries at 100 bytes each with a 200-byte budget: only the newest
    // two survive, and the budget is round-tripped.
    expect(cache.has('k0')).toBe(false)
    expect(cache.has('k3')).toBe(true)
    expect(cache.bytes).toBe(200)

    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
    for (let i = 0; i < 2; i++) {
      expect(cache.set(`fresh${i}`, 'x'.repeat(100))).toBe(true)
    }
    expect(cache.bytes).toBe(200)
  })
})
