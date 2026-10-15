import { describe, expect, test } from 'bun:test'
import {
  colorFileCacheKey,
  createColorFileCache,
  type ColorFileCacheEntry,
  estimateColorFileEntrySize,
  getCachedColorFileInstance,
} from '../colorFileCache'

type ColorFileCtor = new (
  code: string,
  filePath: string,
) => ColorFileCacheEntry['colorFile']

// Test double for the napi ColorFile constructor: records invocations so
// tests can verify hit vs. miss without touching the real native module.
function makeFakeColorFileCtor(calls: { count: number }): ColorFileCtor {
  class FakeColorFile {
    code: string
    filePath: string
    constructor(code: string, filePath: string) {
      calls.count++
      this.code = code
      this.filePath = filePath
    }
  }
  return FakeColorFile as unknown as ColorFileCtor
}

describe('estimateColorFileEntrySize', () => {
  test('is code length × 2 plus a flat 4 KiB napi-handle overhead', () => {
    const stub = {
      render: () => null,
    } as unknown as ColorFileCacheEntry['colorFile']
    expect(estimateColorFileEntrySize({ colorFile: stub, code: '' })).toBe(4096)
    expect(estimateColorFileEntrySize({ colorFile: stub, code: 'abcd' })).toBe(
      4 * 2 + 4096,
    )
  })
})

describe('colorFileCacheKey', () => {
  test('encodes filePath and code length', () => {
    // 'const x = 1' is 11 chars → "a.ts\0" + "11".
    expect(colorFileCacheKey('a.ts', 'const x = 1')).toBe('a.ts\x0011')
  })

  test('different contents with the same path/length share a key', () => {
    // This collision is why the entry retains `code`: the lookup re-verifies
    // string equality before reusing an instance.
    expect(colorFileCacheKey('a.ts', 'abc')).toBe(
      colorFileCacheKey('a.ts', 'xyz'),
    )
  })
})

describe('createColorFileCache / getCachedColorFileInstance', () => {
  test('same code + path hits the cached instance, constructor runs once', () => {
    const calls = { count: 0 }
    const ColorFile = makeFakeColorFileCtor(calls)
    const cache = createColorFileCache()

    const first = getCachedColorFileInstance(
      cache,
      ColorFile,
      'const a = 1',
      'a.ts',
    )
    const second = getCachedColorFileInstance(
      cache,
      ColorFile,
      'const a = 1',
      'a.ts',
    )
    expect(second).toBe(first)
    expect(calls.count).toBe(1)
    expect(cache.size).toBe(1)
  })

  test('same path + length but different code re-constructs', () => {
    // Key collision is prevented by re-verifying the entry's `code`.
    const calls = { count: 0 }
    const ColorFile = makeFakeColorFileCtor(calls)
    const cache = createColorFileCache()

    const a = getCachedColorFileInstance(
      cache,
      ColorFile,
      'const a = 1',
      'a.ts',
    )
    const b = getCachedColorFileInstance(
      cache,
      ColorFile,
      'const b = 1',
      'a.ts',
    )
    expect(b).not.toBe(a)
    expect(calls.count).toBe(2)
    // The stale entry was replaced, not duplicated.
    expect(cache.size).toBe(1)
  })

  test('entry count is bounded by the byte budget (LRU eviction)', () => {
    const calls = { count: 0 }
    const ColorFile = makeFakeColorFileCtor(calls)
    // 'code' = 4 chars → 4×2 + 4096 = 4104 bytes/entry; exactly three fit.
    const cache = createColorFileCache({
      maxTotalBytes: 12_500,
      maxItemBytes: 8_000,
    })

    for (let i = 0; i < 10; i++) {
      getCachedColorFileInstance(cache, ColorFile, 'code', `file-${i}.ts`)
    }
    expect(cache.size).toBe(3)
    expect(cache.bytes).toBe(4104 * 3)
    // Only the three most-recently-used keys survive. 注意 cache 的键是
    // colorFileCacheKey(filePath, code)（path + '\0' + code length），
    // 不能直接用裸 path 查询 has()。
    expect(cache.has(colorFileCacheKey('file-6.ts', 'code'))).toBe(false)
    expect(cache.has(colorFileCacheKey('file-7.ts', 'code'))).toBe(true)
    expect(cache.has(colorFileCacheKey('file-9.ts', 'code'))).toBe(true)
  })

  test('code above the per-item budget is returned but never cached', () => {
    const calls = { count: 0 }
    const ColorFile = makeFakeColorFileCtor(calls)
    // estimate = 5000×2 + 4096 = 14096 > 8_000 per-item limit.
    const cache = createColorFileCache({
      maxTotalBytes: 1_000_000,
      maxItemBytes: 8_000,
    })
    const code = 'x'.repeat(5000)

    const first = getCachedColorFileInstance(cache, ColorFile, code, 'big.ts')
    const second = getCachedColorFileInstance(cache, ColorFile, code, 'big.ts')
    // Same input, but the instance is rebuilt every time — oversized entries
    // behave exactly like a cache miss.
    expect(second).not.toBe(first)
    expect(calls.count).toBe(2)
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })
})
