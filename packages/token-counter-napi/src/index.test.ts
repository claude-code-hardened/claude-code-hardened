import { describe, expect, test } from 'bun:test'
import {
  isNativeTokenizerAvailable,
  nativeCountTokens,
  nativeCountTokensBatch,
} from './index.js'

describe('token-counter-napi loader', () => {
  test('never throws when native module is missing', () => {
    // On platforms without a CI-built .node artifact the loader must
    // silently degrade — available=false, all functions return null.
    expect(() => isNativeTokenizerAvailable()).not.toThrow()
    expect(() => nativeCountTokens('hello')).not.toThrow()
    expect(() => nativeCountTokensBatch(['a', 'b'])).not.toThrow()
  })

  test('nativeCountTokens returns number or null', () => {
    const result = nativeCountTokens('hello world')
    if (isNativeTokenizerAvailable()) {
      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThan(0)
    } else {
      expect(result).toBeNull()
    }
  })

  test('nativeCountTokens returns 0 for empty string', () => {
    const result = nativeCountTokens('')
    if (isNativeTokenizerAvailable()) {
      expect(result).toBe(0)
    } else {
      expect(result).toBeNull()
    }
  })

  test('nativeCountTokens handles multi-byte CJK without error', () => {
    const result = nativeCountTokens('你好，世界')
    if (isNativeTokenizerAvailable() && result !== null) {
      // CJK chars are ~1-2 tokens each under cl100k — never 0
      expect(result).toBeGreaterThanOrEqual(4)
    } else {
      expect(result).toBeNull()
    }
  })

  test('batch results are consistent with single calls', () => {
    const texts = ['hello world', '你好，世界', 'a'.repeat(1000)]
    const batch = nativeCountTokensBatch(texts)
    if (isNativeTokenizerAvailable() && batch !== null) {
      expect(batch).toHaveLength(texts.length)
      for (let i = 0; i < texts.length; i++) {
        const single = nativeCountTokens(texts[i])
        if (single === null) continue
        expect(batch[i]).toBe(single)
      }
    }
  })

  test('counts scale with content length', () => {
    if (!isNativeTokenizerAvailable()) return
    const short = nativeCountTokens('hi')
    const long = nativeCountTokens('hi '.repeat(1000))
    if (short === null || long === null) return
    expect(long).toBeGreaterThan(short)
  })
})
