/**
 * Tests for src/services/nativeTokenCache.ts — the byte-budgeted,
 * short-hash-keyed LRU cache backing tokenEstimation's native counter (M3).
 *
 * Official-baseline behavior note: this cache is a CCH memory guard, not an
 * official structure — the contract being pinned here is "hit semantics of
 * the old 512-entry full-text Map, minus the content retention" (MEMORY_
 * PROJECTION releases tool_result originals in query.ts:626-654 and
 * microCompact.ts clearToolResultProjection; with full-text keys the old Map
 * was regularly the last strong-reference holder).
 *
 * No mocks needed: the module only imports cacheBudget (lru-cache) and
 * hash.ts — keeping this file in its own module is what makes it testable
 * alongside the tokenEstimation-mocking siblings in the shared worker.
 */
import { describe, expect, test } from 'bun:test'
import {
  createNativeTokenCache,
  nativeTokenCacheKey,
} from 'src/services/nativeTokenCache.js'

describe('createNativeTokenCache — hit semantics', () => {
  test('hit returns the count without recomputing (Map-equivalent)', () => {
    let computes = 0
    // Separate store so the cache itself stays pure: the caller wires its
    // own compute fn (tokenEstimation wires nativeCountTokens).
    const store = new Map<string, number>()
    const cache = createNativeTokenCache()
    const content = 'a'.repeat(10_000)

    const first =
      store.get(content) ??
      (() => {
        computes++
        const v = 1234
        store.set(content, v)
        return v
      })()
    cache.set(content, first)

    expect(cache.get(content)).toBe(1234)
    // Second call: pure cache hit — no recompute, same value.
    expect(cache.get(content)).toBe(1234)
    expect(computes).toBe(1)
    expect(cache.size).toBe(1)
  })

  test('key shortening: the cache key never contains the content', () => {
    const content = 'x'.repeat(100_000)
    const key = nativeTokenCacheKey(content)
    // Short hash + length only (wyhash decimal digits + ':' + digits).
    expect(key.length).toBeLessThan(64)
    expect(key).not.toContain(content.slice(0, 16))
    expect(key.endsWith(`:${content.length}`)).toBe(true)
    // Deterministic for identical content; distinct for different content.
    expect(nativeTokenCacheKey(content)).toBe(key)
    expect(nativeTokenCacheKey(content + '!')).not.toBe(key)
    // Same length, different content — the hash must disambiguate.
    expect(nativeTokenCacheKey('b'.repeat(100_000))).not.toBe(key)
  })

  test('set returns the stored count and has/clear behave Map-like', () => {
    const cache = createNativeTokenCache()
    expect(cache.get('missing')).toBeUndefined()
    expect(cache.set('hello world', 3)).toBe(true)
    expect(cache.get('hello world')).toBe(3)
    expect(cache.size).toBe(1)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
    expect(cache.get('hello world')).toBeUndefined()
  })
})

describe('createNativeTokenCache — byte budget (memory assertions)', () => {
  test('oversized content is counted but never stored (per-item cap)', () => {
    const cache = createNativeTokenCache({
      maxTotalBytes: 8 * 1024 * 1024,
      maxItemBytes: 1024,
    })
    const big = 'a'.repeat(8 * 1024) // 8 KB content > 1 KB item cap
    expect(cache.set(big, 9999)).toBe(false)
    expect(cache.get(big)).toBeUndefined()
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })

  test('inserting past the total budget evicts the LRU entry', () => {
    // Entry charge = contentBytes + 64 (key/wrapper overhead). Three 400-byte
    // contents: 3 × 464 = 1392 fits 1400; a fourth insert must evict.
    const cache = createNativeTokenCache({
      maxTotalBytes: 1400,
      maxItemBytes: 10_000,
    })
    const c1 = '1'.repeat(400)
    const c2 = '2'.repeat(400)
    const c3 = '3'.repeat(400)
    const c4 = '4'.repeat(400)
    expect(cache.set(c1, 100)).toBe(true)
    expect(cache.set(c2, 200)).toBe(true)
    expect(cache.set(c3, 300)).toBe(true)
    expect(cache.size).toBe(3)

    // Touching c1 promotes it; c2 becomes the LRU entry.
    expect(cache.get(c1)).toBe(100)
    expect(cache.set(c4, 400)).toBe(true)

    expect(cache.get(c1)).toBe(100) // promoted, survives
    expect(cache.get(c2)).toBeUndefined() // LRU-evicted
    expect(cache.get(c3)).toBe(300)
    expect(cache.get(c4)).toBe(400)
    // The budget never exceeds the cap: memory assertion.
    expect(cache.bytes).toBeLessThanOrEqual(1400)
  })

  test('re-inserting an evicted content frees budget and recomputes', () => {
    // 828 < 2 × (400 + 64): a second full entry cannot coexist, so inserting
    // b must evict a (LRU evicts on would-exceed, not on exact fill).
    const cache = createNativeTokenCache({
      maxTotalBytes: 828,
      maxItemBytes: 10_000,
    })
    // Two entries never fit together: 2 × (400 + 64) = 928 > 828.
    const a = 'a'.repeat(400)
    const b = 'b'.repeat(400)
    cache.set(a, 1)
    cache.set(b, 2)
    expect(cache.get(a)).toBeUndefined() // a was evicted by b
    expect(cache.bytes).toBeLessThanOrEqual(828)
    // Re-inserting a evicts b and re-fits the budget.
    expect(cache.set(a, 111)).toBe(true)
    expect(cache.get(a)).toBe(111)
    expect(cache.get(b)).toBeUndefined()
    expect(cache.bytes).toBeLessThanOrEqual(828)
  })

  test('default budget (8 MiB total, 1 MiB per item) is the M3 contract', () => {
    const cache = createNativeTokenCache()
    // Just under the 1 MiB per-item cap: stored.
    const near = 'a'.repeat(1024 * 1024 - 128)
    expect(cache.set(near, 7)).toBe(true)
    expect(cache.get(near)).toBe(7)
    // Over the cap: not stored — a single giant tool_result cannot pin the
    // budget that used to accumulate 512 × content under full-text keys.
    const over = 'a'.repeat(1024 * 1024 + 1)
    expect(cache.set(over, 8)).toBe(false)
    expect(cache.get(over)).toBeUndefined()
    cache.clear()
    expect(cache.bytes).toBe(0)
  })
})
