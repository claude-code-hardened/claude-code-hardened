import { describe, expect, test } from 'bun:test'
import { structuredPatch } from '../index'
import {
  jsDiffLines,
  jsStructuredPatch,
  structuredPatchFromChanges,
} from '../jsDiff'

describe('structuredPatch (native-first wrapper)', () => {
  test('returns a single hunk with context lines', () => {
    const result = structuredPatch(
      'line1\nline2\nline3\nline4\nline5',
      'line1\nline2\nX\nline4\nline5',
      {
        context: 1,
      },
    )
    expect(result).not.toBeNull()
    expect(result!.hunks).toHaveLength(1)
    const hunk = result!.hunks[0]!
    expect(hunk.oldStart).toBe(2)
    expect(hunk.oldLines).toBe(3)
    expect(hunk.newStart).toBe(2)
    expect(hunk.newLines).toBe(3)
    expect(hunk.lines).toEqual([' line2', '-line3', '+X', ' line4'])
  })

  test('returns empty hunks for identical content', () => {
    const result = structuredPatch('same\ncontent', 'same\ncontent')
    expect(result).not.toBeNull()
    expect(result!.hunks).toEqual([])
  })

  test('splits distant changes into separate hunks', () => {
    const oldStr = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const newStr = oldStr.replace('l2', 'CHANGED').replace('l17', 'CHANGED')
    const result = structuredPatch(oldStr, newStr, { context: 1 })
    expect(result!.hunks).toHaveLength(2)
  })

  test('large context merges everything into one hunk', () => {
    const oldStr = 'a\nb\nc\nd\ne\nf\ng'
    const newStr = 'a\nb\nC\nd\ne\nf\nG'
    const merged = structuredPatch(oldStr, newStr, { context: 100_000 })
    expect(merged!.hunks).toHaveLength(1)
  })

  test('marks missing trailing newline like jsdiff', () => {
    const result = structuredPatch('keep\nold end', 'keep\nnew end')
    const lines = result!.hunks[0]!.lines
    expect(lines).toContain('-old end')
    expect(lines).toContain('+new end')
    expect(lines).toContain('\\ No newline at end of file')
  })

  test('ignoreWhitespace treats indentation changes as identical', () => {
    // ignoreWhitespace forces the pure-JS path (the native diff has no
    // trim-equality mode), so this also covers the fallback.
    const result = structuredPatch(
      'function foo() {\n  return 42;\n}\n',
      'function foo() {\n\treturn 42;\n}\n',
      {
        ignoreWhitespace: true,
      },
    )
    expect(result!.hunks).toEqual([])
  })

  test('pure-JS fallback matches native-path shape', () => {
    const oldStr = 'alpha\nbeta\ngamma\ndelta'
    const newStr = 'alpha\nbeta\nGAMMA\ndelta'
    const viaWrapper = structuredPatch(oldStr, newStr, { context: 1 })
    const viaJs = jsStructuredPatch(oldStr, newStr, { context: 1 })
    expect(viaWrapper!.hunks).toEqual(viaJs!)
  })
})

describe('jsDiffLines', () => {
  test('merges contiguous same-tag runs and counts lines', () => {
    const changes = jsDiffLines('a\nb\nc\n', 'a\nX\nc\n')
    expect(changes).toEqual([
      { value: 'a\n', count: 1, added: false, removed: false },
      { value: 'b\n', count: 1, added: false, removed: true },
      { value: 'X\n', count: 1, added: true, removed: false },
      { value: 'c\n', count: 1, added: false, removed: false },
    ])
  })

  // Verified against real jsdiff 8.0.4 (node_modules/diff): the last line
  // without a trailing newline is a distinct token from the same line with
  // one, so the shared 'a\n' stays common and only the final line is
  // removed/re-added — jsdiff does NOT collapse this into a whole-text
  // remove+add pair.
  test('keeps the last line without a trailing newline', () => {
    const changes = jsDiffLines('a\nb', 'a\nb\n')
    expect(changes).toEqual([
      { value: 'a\n', count: 1, added: false, removed: false },
      { value: 'b', count: 1, added: false, removed: true },
      { value: 'b\n', count: 1, added: true, removed: false },
    ])
  })

  test('matches jsdiff 8.0.4 on trailing-newline edge cases', () => {
    // Each expectation below was probed against the real jsdiff 8.0.4
    // package (diffLines executed directly).
    // Only-newline difference in either direction: no common token at all.
    expect(jsDiffLines('a\n', 'a')).toEqual([
      { value: 'a\n', count: 1, added: false, removed: true },
      { value: 'a', count: 1, added: true, removed: false },
    ])
    expect(jsDiffLines('a', 'a\n')).toEqual([
      { value: 'a', count: 1, added: false, removed: true },
      { value: 'a\n', count: 1, added: true, removed: false },
    ])
    expect(jsDiffLines('a\nb\n', 'a\nb')).toEqual([
      { value: 'a\n', count: 1, added: false, removed: false },
      { value: 'b\n', count: 1, added: false, removed: true },
      { value: 'b', count: 1, added: true, removed: false },
    ])
    // Appending a final newline keeps earlier lines common.
    expect(jsDiffLines('a\nb\nc', 'a\nb\nc\n')).toEqual([
      { value: 'a\nb\n', count: 2, added: false, removed: false },
      { value: 'c', count: 1, added: false, removed: true },
      { value: 'c\n', count: 1, added: true, removed: false },
    ])
    // Trailing \r change on the unterminated last line.
    expect(jsDiffLines('a\nb', 'a\nb\r\n')).toEqual([
      { value: 'a\n', count: 1, added: false, removed: false },
      { value: 'b', count: 1, added: false, removed: true },
      { value: 'b\r\n', count: 1, added: true, removed: false },
    ])
    // Empty-string boundaries.
    expect(jsDiffLines('', 'a')).toEqual([
      { value: 'a', count: 1, added: true, removed: false },
    ])
    expect(jsDiffLines('a', '')).toEqual([
      { value: 'a', count: 1, added: false, removed: true },
    ])
  })

  test('returns undefined when maxEditLength is exceeded', () => {
    const changes = jsDiffLines('a\nb\nc', 'x\ny\nz', { maxEditLength: 2 })
    expect(changes).toBeUndefined()
  })
})

describe('structuredPatchFromChanges', () => {
  test('appends no-newline markers after lines lacking a newline', () => {
    const hunks = structuredPatchFromChanges(
      [
        { value: 'x\ny', count: 2, added: false, removed: true },
        { value: 'x\nz', count: 2, added: true, removed: false },
      ],
      3,
    )
    expect(hunks).toEqual([
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          '-x',
          '-y',
          '\\ No newline at end of file',
          '+x',
          '+z',
          '\\ No newline at end of file',
        ],
      },
    ])
  })
})
