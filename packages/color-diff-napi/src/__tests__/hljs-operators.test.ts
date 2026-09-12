import { describe, expect, test } from 'bun:test'
import hljs from 'highlight.js'
import { __test } from '../index'

const { flattenHljs, buildTheme } = __test

type Color = { r: number; g: number; b: number; a: number }
type Block = [{ foreground: Color; background: Color }, string]

// Light theme → GITHUB_SCOPES (operator rgb(167,29,93) = #a71d5d)
const theme = buildTheme('light', 'color256') as unknown as {
  scopes: Record<string, Color>
  tm: null
  foreground: Color
}
const OPERATOR = theme.scopes['operator']!

function flattenCode(code: string, lang: string): Block[] {
  const result = hljs.highlight(code, { language: lang, ignoreIllegals: true })
  const emitter = (result as unknown as { _emitter?: { rootNode?: unknown } })
    ._emitter
  if (!emitter?.rootNode) throw new Error('no hljs rootNode')
  const blocks: Block[] = []
  flattenHljs(emitter.rootNode as never, theme, undefined, blocks)
  return blocks
}

function findText(blocks: Block[], text: string): Block | undefined {
  return blocks.find(([, t]) => t === text)
}

describe('flattenHljs untagged operator coloring', () => {
  test('standalone = between identifiers gets the operator color', () => {
    const blocks = flattenCode('let y = v;', 'javascript')
    const eq = findText(blocks, '=')
    expect(eq).toBeDefined()
    expect(eq![0]!.foreground).toEqual(OPERATOR)
  })

  test('=== is colored as a single operator unit', () => {
    const blocks = flattenCode('if (a === b) {}', 'javascript')
    const op = findText(blocks, '===')
    expect(op).toBeDefined()
    expect(op![0]!.foreground).toEqual(OPERATOR)
    // and no bare '=' block leaked from a partial match
    expect(findText(blocks, '=')).toBeUndefined()
  })

  test('string content is not operator-colored', () => {
    const blocks = flattenCode("let s = 'a = b';", 'javascript')
    const strBlock = blocks.find(([, t]) => t.includes('a = b'))
    expect(strBlock).toBeDefined()
    expect(strBlock![0]!.foreground).not.toEqual(OPERATOR)
    // the string's own '=' was never split out as a standalone block
    const standaloneEq = blocks.filter(([, t]) => t === '=')
    expect(standaloneEq.length).toBe(1) // only the assignment operator
  })

  test('comment content is not operator-colored', () => {
    const blocks = flattenCode('const ok = 1; // x = y', 'javascript')
    const comment = blocks.find(([, t]) => t.includes('x = y'))
    expect(comment).toBeDefined()
    expect(comment![0]!.foreground).not.toEqual(OPERATOR)
  })

  test('ambiguous angle brackets stay default-colored', () => {
    const blocks = flattenCode('const a: Array<number> = [];', 'typescript')
    const lt = findText(blocks, '<')
    if (lt) {
      expect(lt[0]!.foreground).not.toEqual(OPERATOR)
    }
  })

  test('identifiers keep the default foreground', () => {
    const blocks = flattenCode('let y = v;', 'javascript')
    const ident = blocks.find(([, t]) => t.trim() === 'y')
    expect(ident).toBeDefined()
    expect(ident![0]!.foreground).toEqual(theme.foreground)
  })
})
