import { describe, expect, test } from 'bun:test'
import { marked, type Token } from 'marked'
import {
  createTokenCache,
  estimateTokenTreeSize,
  padAligned,
} from '../markdown'

// Token-shaped fixture the walker counts deterministically: one node whose
// raw + text together contribute 2 * 2 * len bytes and a flat 64 per node.
function textTokenTree(len: number): Token[] {
  const text = 'x'.repeat(len)
  return [{ type: 'text', raw: text, text: text }]
}

describe('estimateTokenTreeSize', () => {
  test('counts raw+text chars × 2 plus 64 bytes per node', () => {
    // 1 node; raw(4) + text(4) = 8 chars → 16 + 64.
    expect(estimateTokenTreeSize(textTokenTree(4))).toBe(8 * 2 + 1 * 64)
  })

  test('walks List `items` nesting, not only `tokens`', () => {
    // marked's ListToken hangs children off `items`; the structural walk must
    // follow it or list text would be missed in cache accounting.
    const list = {
      type: 'list',
      raw: '',
      items: [{ type: 'text', raw: 'abcd', text: 'abcd' }],
    }
    // 2 nodes (list + item), 8 text chars → 16 + 128.
    expect(estimateTokenTreeSize([list])).toBe(8 * 2 + 2 * 64)
  })

  test('grows monotonically with content length', () => {
    const small = estimateTokenTreeSize(marked.lexer('hello'))
    const large = estimateTokenTreeSize(marked.lexer('hello '.repeat(500)))
    expect(large).toBeGreaterThan(small)
  })

  test('real lexer output of a mixed document stays within sane bounds', () => {
    const doc = [
      '# Title',
      '',
      '- item one',
      '- item two',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '| a | b |',
      '| - | - |',
    ].join('\n')
    const size = estimateTokenTreeSize(marked.lexer(doc))
    expect(size).toBeGreaterThan(0)
    // Node overhead dominates a doc this small; just make sure the estimate
    // is in the hundreds, not zero or megabytes.
    expect(size).toBeLessThan(100 * 1024)
  })
})

describe('createTokenCache', () => {
  test('hit returns the identical tree — repeat renders never re-lex', () => {
    const cache = createTokenCache()
    const tokens = marked.lexer('# heading\n\nbody paragraph')
    expect(cache.set('hash-1', tokens)).toBe(true)
    expect(cache.get('hash-1')).toBe(tokens)
    expect(cache.get('hash-1')).toBe(tokens)
    expect(cache.size).toBe(1)
  })

  test('entry count is bounded by the byte budget (LRU eviction)', () => {
    // textTokenTree(30) = 120 chars + 64 = 184 bytes. Budget fits two trees.
    const cache = createTokenCache({ maxTotalBytes: 368, maxItemBytes: 184 })
    cache.set('a', textTokenTree(30))
    cache.set('b', textTokenTree(30))
    expect(cache.size).toBe(2)
    // Inserting a third evicts the least-recently-used tree ('a').
    cache.set('c', textTokenTree(30))
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.bytes).toBe(368)
  })

  test('trees above the per-item budget are never stored', () => {
    // Oversized trees behave like a miss: re-lex on every render.
    const cache = createTokenCache()
    // ~1.3 MB of text → estimate well above the 1 MiB per-item default.
    const tokens = marked.lexer('single huge paragraph '.repeat(60_000))
    expect(estimateTokenTreeSize(tokens)).toBeGreaterThan(1024 * 1024)
    expect(cache.set('big', tokens)).toBe(false)
    expect(cache.has('big')).toBe(false)
    expect(cache.size).toBe(0)
  })
})

describe('padAligned', () => {
  test('left-aligns: pads with spaces on right', () => {
    const result = padAligned('hello', 5, 10, 'left')
    expect(result).toBe('hello     ')
    expect(result.length).toBe(10)
  })

  test('right-aligns: pads with spaces on left', () => {
    const result = padAligned('hello', 5, 10, 'right')
    expect(result).toBe('     hello')
    expect(result.length).toBe(10)
  })

  test('center-aligns: pads with spaces on both sides', () => {
    const result = padAligned('hi', 2, 6, 'center')
    expect(result).toBe('  hi  ')
    expect(result.length).toBe(6)
  })

  test('no padding when displayWidth equals targetWidth', () => {
    const result = padAligned('hello', 5, 5, 'left')
    expect(result).toBe('hello')
  })

  test('handles content wider than targetWidth', () => {
    const result = padAligned('hello world', 11, 5, 'left')
    expect(result).toBe('hello world')
  })

  test('null/undefined align defaults to left', () => {
    expect(padAligned('hi', 2, 5, null)).toBe('hi   ')
    expect(padAligned('hi', 2, 5, undefined)).toBe('hi   ')
  })

  test('handles empty string content', () => {
    const result = padAligned('', 0, 5, 'center')
    expect(result).toBe('     ')
  })

  test('handles zero displayWidth', () => {
    const result = padAligned('', 0, 3, 'left')
    expect(result).toBe('   ')
  })

  test('handles zero targetWidth', () => {
    const result = padAligned('hello', 5, 0, 'left')
    expect(result).toBe('hello')
  })

  test('center alignment with odd padding distribution', () => {
    const result = padAligned('hi', 2, 7, 'center')
    expect(result).toBe('  hi   ')
    expect(result.length).toBe(7)
  })
})
