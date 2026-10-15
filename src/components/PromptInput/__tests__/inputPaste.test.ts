import { describe, expect, test } from 'bun:test'
import { expandPastedTextRefs, parseReferences } from 'src/history.js'
import {
  PASTE_FOLD_MAX_LINE_BREAKS,
  PASTE_FOLD_THRESHOLD,
  TRUNCATION_THRESHOLD,
  foldPasteAtEntry,
  maybeTruncateInput,
  maybeTruncateMessageForInput,
  shouldFoldPaste,
} from '../inputPaste.js'

describe('shouldFoldPaste', () => {
  test('does not fold a paste of exactly 800 chars (boundary)', () => {
    expect(shouldFoldPaste('a'.repeat(PASTE_FOLD_THRESHOLD))).toBe(false)
  })

  test('folds a paste of 801 chars', () => {
    expect(shouldFoldPaste('a'.repeat(PASTE_FOLD_THRESHOLD + 1))).toBe(true)
  })

  test('does not fold exactly 2 line breaks (boundary)', () => {
    expect(shouldFoldPaste('a\nb\nc')).toBe(false)
  })

  test('folds a paste with 3 line breaks', () => {
    expect(shouldFoldPaste('a\nb\nc\nd')).toBe(true)
  })

  test('folds a CRLF paste with 3 line breaks', () => {
    expect(shouldFoldPaste('a\r\nb\r\nc\r\nd')).toBe(true)
  })

  test('folds when both char and linebreak thresholds are exceeded', () => {
    expect(shouldFoldPaste('a'.repeat(900) + '\n'.repeat(3))).toBe(true)
  })
})

describe('foldPasteAtEntry', () => {
  test('emits the official [Pasted text #N +M lines] placeholder literal', () => {
    const fold = foldPasteAtEntry('a\nb\nc\nd', 7)
    expect(fold.folded).toBe(true)
    expect(fold.refText).toBe('[Pasted text #7 +3 lines]')
  })

  test('emits the 0-line literal for a long single-line paste', () => {
    const fold = foldPasteAtEntry('x'.repeat(PASTE_FOLD_THRESHOLD + 1), 1)
    expect(fold.folded).toBe(true)
    expect(fold.refText).toBe('[Pasted text #1]')
  })

  test('keeps short single-line pastes unfolded', () => {
    const fold = foldPasteAtEntry('hello', 1)
    expect(fold).toEqual({ folded: false, refText: '', pastedContent: null })
  })

  test('does not fold a paste of exactly 800 chars at the entry', () => {
    const fold = foldPasteAtEntry('a'.repeat(PASTE_FOLD_THRESHOLD), 1)
    expect(fold.folded).toBe(false)
  })

  test('does not fold a paste with exactly 2 line breaks', () => {
    expect(foldPasteAtEntry('a\nb\nc', 1).folded).toBe(false)
  })

  test('carries the full original content in pastedContent', () => {
    const text = `${'line\n'.repeat(10)}end`
    const fold = foldPasteAtEntry(text, 3)
    if (!fold.folded) throw new Error('expected fold')
    expect(fold.pastedContent).toEqual({
      id: 3,
      type: 'text',
      content: text,
    })
  })
})

describe('placeholder compatibility (new & legacy formats)', () => {
  test('parseReferences recognizes the new official placeholder', () => {
    const fold = foldPasteAtEntry('a\nb\nc\nd', 5)
    const refs = parseReferences(fold.refText)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.id).toBe(5)
    expect(refs[0]!.match).toBe('[Pasted text #5 +3 lines]')
  })

  test('parseReferences recognizes the legacy Truncated-text placeholder', () => {
    const refs = parseReferences('[...Truncated text #2 +5 lines...]')
    expect(refs).toHaveLength(1)
    expect(refs[0]!.id).toBe(2)
  })

  test('expandPastedTextRefs restores the folded paste losslessly', () => {
    const text = 'alpha\nbeta\ngamma\ndelta'
    const fold = foldPasteAtEntry(text, 4)
    if (!fold.folded) throw new Error('expected fold')
    expect(
      expandPastedTextRefs(`go ${fold.refText} now`, {
        [4]: fold.pastedContent,
      }),
    ).toBe(`go ${text} now`)
  })
})

describe('maybeTruncate* (legacy >10000 fallback kept)', () => {
  test('returns text unchanged at exactly 10000 chars (boundary)', () => {
    const text = 'a'.repeat(10000)
    const result = maybeTruncateMessageForInput(text, 1)
    expect(result.truncatedText).toBe(text)
    expect(result.placeholderContent).toBe('')
  })

  test('truncates past 10000 chars with the legacy truncated ref', () => {
    const text = `${'x'.repeat(10000)}y`
    const result = maybeTruncateMessageForInput(text, 2)
    expect(result.placeholderContent).not.toBe('')
    expect(result.truncatedText).toContain('[...Truncated text #2 +')
    expect(result.truncatedText.endsWith('y')).toBe(true)
  })

  test('registers fallback content in pastedContents', () => {
    const result = maybeTruncateInput('y'.repeat(TRUNCATION_THRESHOLD + 1), {})
    const content = result.newPastedContents[1]
    expect(content?.type).toBe('text')
    expect(content?.content.length).toBeGreaterThan(0)
    expect(result.newInput).toContain('[...Truncated text #1')
  })

  test('fold threshold sits below the legacy fallback threshold', () => {
    expect(PASTE_FOLD_THRESHOLD).toBe(800)
    expect(PASTE_FOLD_MAX_LINE_BREAKS).toBe(2)
    expect(PASTE_FOLD_THRESHOLD).toBeLessThan(TRUNCATION_THRESHOLD)
  })
})
