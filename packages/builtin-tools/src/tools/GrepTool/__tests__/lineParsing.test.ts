import { mock, describe, expect, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

// Mock log/debug to cut the heavy dependency chain (bootstrap/state.ts SCC)
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

const { splitContentLine, relativeContentLine } = await import('../GrepTool')

// ─── splitContentLine ───────────────────────────────────────────────────

describe('splitContentLine', () => {
  test('posix path with line number', () => {
    expect(splitContentLine('/tmp/proj/a.ts:12:let x = 1')).toEqual([
      '/tmp/proj/a.ts',
      ':12:let x = 1',
    ])
  })

  test('windows drive-letter path does not split after C:', () => {
    expect(splitContentLine('C:\\a.ts:12:x = 1')).toEqual([
      'C:\\a.ts',
      ':12:x = 1',
    ])
  })

  test('windows drive-letter path with nested path keeps drive intact', () => {
    expect(splitContentLine('C:\\proj\\src\\a.ts:3:ok')).toEqual([
      'C:\\proj\\src\\a.ts',
      ':3:ok',
    ])
  })

  test('windows path without line numbers is passed through unsplit', () => {
    // The only non-escaped colon is the drive separator — no safe split point.
    expect(splitContentLine('C:\\a.ts:def foo()')).toBeNull()
  })

  test('backslash-escaped colon in path is skipped', () => {
    expect(splitContentLine('a\\:b.ts:12:x')).toEqual(['a\\:b.ts', ':12:x'])
  })

  test('escaped colon immediately followed by digits does not fool the split', () => {
    expect(splitContentLine('a\\:12.ts:x')).toEqual(['a\\:12.ts', ':x'])
    expect(splitContentLine('a\\:12.ts:5:x')).toEqual(['a\\:12.ts', ':5:x'])
  })

  test('line without line numbers falls back to the first plain colon', () => {
    expect(splitContentLine('/tmp/proj/a.ts:def foo(): void')).toEqual([
      '/tmp/proj/a.ts',
      ':def foo(): void',
    ])
  })

  test('content containing colon-digits does not fool the line-number split', () => {
    expect(splitContentLine('/tmp/proj/a.ts:12:3 of them')).toEqual([
      '/tmp/proj/a.ts',
      ':12:3 of them',
    ])
  })

  test('lines without any colon pass through', () => {
    expect(splitContentLine('no colon here')).toBeNull()
  })
})

// ─── relativeContentLine ────────────────────────────────────────────────

describe('relativeContentLine', () => {
  test('keeps the separator and content after the line number', () => {
    // Path outside cwd → toRelativePath keeps it absolute; the assertion is
    // that position parsing put the whole path before ':7:' untouched.
    expect(relativeContentLine('/cch-outside-cwd/a.ts:7:hi')).toBe(
      '/cch-outside-cwd/a.ts:7:hi',
    )
  })

  test('windows drive letter survives relativization', () => {
    expect(relativeContentLine('C:\\a.ts:12:hi')).toContain('C:\\a.ts:12:hi')
  })

  test('lines without a recognized separator pass through unchanged', () => {
    expect(relativeContentLine('C:\\a.ts:no digits')).toBe(
      'C:\\a.ts:no digits',
    )
  })
})
