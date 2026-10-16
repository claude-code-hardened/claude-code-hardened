import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Shared porcelain mocks per CLAUDE.md mock rules: log/debug cut the
// bootstrap/state.ts side-effect chain; bun:bundle pins SEARCH_NAPI to true
// (the documented build default — the flag gate itself stays in call()) so
// GrepTool.call exercises the native dispatch; loadNativeModule is pinned to
// null so the "no native artifact" behavior is deterministic even on
// machines where vendor/search/<triple>/search.node has been built (CI's
// quality job runs bun test before any native artifacts land in vendor/).
// There is no rg subprocess branch anymore: with the native module absent
// (loadSearchNative() → null) the only observable behavior is the
// rg-branch-shaped error tool_result, asserted below.
import type * as searchNativeTypes from '../index'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'
import { mockToolContext } from '../../../../tests/mocks/toolContext'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/embeddedNative.ts', () => ({
  loadNativeModule: () => null,
  __esModule: true,
}))
mock.module('bun:bundle', () => ({
  feature: (name: string) => name === 'SEARCH_NAPI',
}))

// Dynamic imports AFTER the mocks (mock.module does not hoist).
const { GrepTool, splitContentLine } = await import(
  '../../../../packages/builtin-tools/src/tools/GrepTool/GrepTool'
)
const searchNative = await import('../index')
const { isValidSearchNativeModule, loadSearchNative, renderGrepMatches } =
  searchNative

const stubCanUseTool = async () => ({ behavior: 'allow' }) as any
const stubParentMessage = {
  type: 'assistant',
  message: { id: 'msg_parent', content: [] },
} as any

// ─── loadSearchNative (structural gate) ─────────────────────────────────

describe('loadSearchNative', () => {
  test('returns null in a test environment without a native artifact', () => {
    expect(loadSearchNative()).toBeNull()
  })

  test('loader result stays null across repeated calls (cached miss)', () => {
    expect(loadSearchNative()).toBeNull()
  })

  test('validate probe rejects a native-shaped fake missing an export', () => {
    // A structurally invalid module must never be accepted — a fake native
    // would otherwise silently swallow searches with garbage results.
    const fake = {
      grepSearch: async () => ({}),
      // findGlob deliberately missing
      searchCancel: () => {},
    }
    expect(isValidSearchNativeModule(fake)).toBe(false)
  })

  test('validate probe rejects non-object / wrong-typed members', () => {
    expect(isValidSearchNativeModule(null)).toBe(false)
    expect(isValidSearchNativeModule('search-napi')).toBe(false)
    expect(
      isValidSearchNativeModule({
        grepSearch: 'not a function',
        findGlob: () => {},
        searchCancel: () => {},
      }),
    ).toBe(false)
  })

  test('validate probe accepts the frozen v1 surface', () => {
    expect(
      isValidSearchNativeModule({
        grepSearch: async () => null,
        findGlob: async () => [],
        searchCancel: () => {},
        isNativeSearch: () => true,
      }),
    ).toBe(true)
  })
})

// ─── renderGrepMatches (rg byte-format anchors) ─────────────────────────

describe('renderGrepMatches', () => {
  function buildMatch(
    partial: Partial<searchNativeTypes.RenderableGrepMatch> & {
      path: string
      line: string
    },
  ): searchNativeTypes.RenderableGrepMatch {
    return {
      lineNumber: 0,
      before: [],
      after: [],
      truncated: null,
      ...partial,
    }
  }

  test('content match line renders path:line:text', () => {
    const out = renderGrepMatches([
      buildMatch({ path: '/proj/a.ts', lineNumber: 12, line: 'let x = 1' }),
    ])
    expect(out).toBe('/proj/a.ts:12:let x = 1')
  })

  test('showLineNumbers:false renders path:text (rg without -n)', () => {
    const out = renderGrepMatches(
      [buildMatch({ path: '/proj/a.ts', lineNumber: 12, line: 'let x = 1' })],
      { showLineNumbers: false },
    )
    expect(out).toBe('/proj/a.ts:let x = 1')
  })

  test('context lines use the hyphen separator path-line-text', () => {
    const out = renderGrepMatches([
      buildMatch({
        path: '/proj/a.ts',
        lineNumber: 12,
        line: 'match',
        before: ['eleven'],
        after: ['thirteen', 'fourteen'],
      }),
    ])
    // rg 14.1.1: context line separator is `-`, match line separator is `:`
    expect(out).toBe(
      '/proj/a.ts-11-eleven\n/proj/a.ts:12:match\n/proj/a.ts-13-thirteen\n/proj/a.ts-14-fourteen',
    )
  })

  test('context mode emits -- between different files, none without context', () => {
    const matches = [
      buildMatch({ path: 'f1.txt', lineNumber: 3, line: 'x1' }),
      buildMatch({ path: 'f2.txt', lineNumber: 5, line: 'x2' }),
    ]
    // rg: --context-separator applies only when context lines exist at all
    expect(renderGrepMatches(matches, { context: true })).toBe(
      'f1.txt:3:x1\n--\nf2.txt:5:x2',
    )
    expect(renderGrepMatches(matches, { context: false })).toBe(
      'f1.txt:3:x1\nf2.txt:5:x2',
    )
  })

  test('context mode emits -- across a same-file line gap, merges adjacency', () => {
    const out = renderGrepMatches(
      [
        buildMatch({ path: 'g.txt', lineNumber: 5, line: 'x1' }),
        buildMatch({ path: 'g.txt', lineNumber: 7, line: 'x2' }),
      ],
      { context: true },
    )
    // gap line 6 → non-contiguous groups → -- (real rg behavior)
    expect(out).toBe('g.txt:5:x1\n--\ng.txt:7:x2')

    const merged = renderGrepMatches(
      [
        buildMatch({
          path: 'g.txt',
          lineNumber: 5,
          line: 'x1',
          after: ['6'],
        }),
        buildMatch({ path: 'g.txt', lineNumber: 7, line: 'x2' }),
      ],
      { context: true },
    )
    // prev group covers through line 6, next starts at 7 → contiguous, no --
    expect(merged).toBe('g.txt:5:x1\ng.txt-6-6\ng.txt:7:x2')
  })

  test('no-context mode never emits separators (rg ignores them)', () => {
    const out = renderGrepMatches([
      buildMatch({ path: 'g.txt', lineNumber: 1, line: 'a' }),
      buildMatch({ path: 'g.txt', lineNumber: 8, line: 'b' }),
    ])
    expect(out).toBe('g.txt:1:a\ng.txt:8:b')
  })

  test('count mode renders path:count, bareCount renders the count only', () => {
    const matches = [
      buildMatch({ path: '/proj/a.ts', line: '7' }),
      buildMatch({ path: '/proj/b.ts', line: '2' }),
    ]
    expect(renderGrepMatches(matches, { mode: 'Count' })).toBe(
      '/proj/a.ts:7\n/proj/b.ts:2',
    )
    expect(renderGrepMatches(matches, { mode: 'Count', bareCount: true })).toBe(
      '7\n2',
    )
  })

  test('files_with_matches mode renders one bare path per line', () => {
    const out = renderGrepMatches(
      [
        buildMatch({ path: '/proj/a.ts', line: '' }),
        buildMatch({ path: '/proj/b.ts', line: '' }),
      ],
      { mode: 'FilesWithMatches' },
    )
    expect(out).toBe('/proj/a.ts\n/proj/b.ts')
  })

  test('truncated match renders the verbatim rg 14.1.1 placeholder', () => {
    const out = renderGrepMatches([
      buildMatch({
        path: '/proj/big.ts',
        lineNumber: 3,
        line: 'ignored',
        truncated: true,
      }),
    ])
    expect(out).toBe('/proj/big.ts:3:[Omitted long matching line]')
  })

  test('empty match list renders an empty string (No matches found path)', () => {
    expect(renderGrepMatches([])).toBe('')
  })

  test('content output round-trips through GrepTool line parsing', () => {
    // The renderer contract: every emitted line is byte-compatible with the
    // rg subprocess output GrepTool already parses (splitContentLine).
    const out = renderGrepMatches(
      [
        buildMatch({
          path: '/proj/a.ts',
          lineNumber: 12,
          line: 'let x = 1',
          before: ['eleven'],
        }),
        buildMatch({ path: '/proj/b.ts', lineNumber: 2, line: 'y = 2' }),
      ],
      { context: true },
    )
    const [l1, l2, l3, l4] = out.split('\n')
    // Context lines and the `--` separator pass through the parser untouched.
    expect(splitContentLine(l1!)).toBeNull()
    expect(splitContentLine(l2!)).toEqual(['/proj/a.ts', ':12:let x = 1'])
    expect(l3).toBe('--')
    expect(splitContentLine(l4!)).toEqual(['/proj/b.ts', ':2:y = 2'])
    expect(splitContentLine('g.txt-6-ctx')).toBeNull()
  })
})

// ─── GrepTool (SEARCH_NAPI on, native module absent → error tool_result) ──

describe('GrepTool with native module missing', () => {
  test('files_with_matches: rejects with the search-unavailable error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'search-napi-err-'))
    await writeFile(join(dir, 'aa.txt'), 'needle in aa\n')

    await expect(
      GrepTool.call(
        {
          pattern: 'needle',
          path: dir,
          output_mode: 'files_with_matches',
        } as unknown as Parameters<typeof GrepTool.call>[0],
        mockToolContext(),
      ),
    ).rejects.toThrow('search unavailable: native module missing')
  })

  test('content mode: rejects the same way (no silent empty results)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'search-napi-err-'))
    await writeFile(join(dir, 'aa.txt'), 'needle in aa\n')

    const callInput = {
      pattern: 'needle',
      path: dir,
      output_mode: 'content',
    } as unknown as Parameters<typeof GrepTool.call>[0]
    // 联合 ToolResult 取窄面：bypasses overload union resolution（测试面合法 as any）。
    await expect(
      (
        GrepTool.call as unknown as (
          ...args: unknown[]
        ) => Promise<{ data: { mode: string; content: string } }>
      )(callInput, mockToolContext(), stubCanUseTool, stubParentMessage),
    ).rejects.toThrow('search unavailable: native module missing')
  })
})
