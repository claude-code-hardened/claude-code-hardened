import { describe, expect, test, mock } from 'bun:test'
import type { Message } from '../../../types/message.js'
import type { QuerySource } from '../../../constants/querySource.js'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

// microCompact.ts transitively imports debug.ts / log.ts, both of which drag
// in bootstrap/state.ts side effects at module init. Use the shared mocks
// (factory fns — mock.module calls them to build the module export shape).
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/log.ts', logMock)

// Cross-worker mock.module pollution shield for the estimator: several test
// files register a len/4-only roughTokenCountEstimation stub
// (autoCompact / tokens.test / CtxInspectTool / SessionMemory prompts), and
// Bun's mock.module is process-global last-write-wins, so whichever ran last
// before this file wins. A divisor-ignoring stub breaks exactly the
// title-extension-divisor document case below: 40_000 text-source chars at
// divisor 2 must count 20_000 (official mun floor boundary), while /4 yields
// 10_000 < 20_000 and the clear bails null (CI /tmp/test2.log:1085 —
// received null). Re-register here with the real runtime semantics
// (feature flags off in CI → len/bytesPerToken rough estimator everywhere)
// so this file's expectations hold regardless of load order.
const estimatorMock = () => ({
  roughTokenCountEstimation: (text: string, bytesPerToken = 4) =>
    Math.round(text.length / bytesPerToken),
  // CI runs with FEATURE_TOKEN_COUNT_NATIVE unset → the real
  // countTokensPrecise falls back to the rough len/4 estimator anyway.
  countTokensPrecise: (text: string) => Math.round(text.length / 4),
  roughTokenCountEstimationForMessages: (
    msgs: readonly { message?: { content?: unknown } }[],
  ) =>
    msgs.reduce((n, m) => {
      const content = m.message?.content
      const text =
        typeof content === 'string' ? content : JSON.stringify(content ?? '')
      return n + Math.round(text.length / 4)
    }, 0),
  roughTokenCountEstimationForMessage: () => 0,
  roughTokenCountEstimationForFileType: () => 0,
  bytesPerTokenForFileType: () => 4,
  countTokensWithAPI: async () => 0,
  countMessagesTokensWithAPI: async () => 0,
  countTokensViaHaikuFallback: async () => 0,
  // tokens.js (realized in this file's graph) binds this from the mocked
  // module — a missing entry kills the whole import link.
  countTokensPreciseForMessages: () => 0,
})
mock.module('src/services/tokenEstimation.ts', estimatorMock)
mock.module('src/services/tokenEstimation.js', estimatorMock)

// Import under test AFTER mocks are registered.
const {
  clearToolResultProjection,
  microcompactMessages,
  TIME_BASED_MC_CLEARED_MESSAGE,
} = await import('../microCompact.js')

import type { ProjectionPersistFn } from '../microCompact.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// ~50k rough tokens each (len/4 estimate): comfortably above the
// MEMORY_PROJECTION_MIN_TOKENS_SAVED (20k) floor in aggregate.
const BIG_CONTENT = 'a'.repeat(200_000)
// ~250 tokens: even 6 of them stay far below the 20k floor.
const SMALL_CONTENT = 'x'.repeat(1_000)

let uuidCounter = 0

function asstWithToolUse(
  id: string,
  name = 'Read',
  input: Record<string, unknown> = {},
): Message {
  uuidCounter++
  return {
    type: 'assistant',
    uuid: `uuid-asst-${uuidCounter}`,
    timestamp: '2026-10-15T00:00:00.000Z',
    message: {
      id: `msg_${id}`,
      role: 'assistant',
      type: 'message',
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as unknown as Message
}

function userWithToolResult(
  id: string,
  content: string | Array<Record<string, unknown>>,
): Message {
  uuidCounter++
  return {
    type: 'user',
    uuid: `uuid-user-${uuidCounter}`,
    timestamp: '2026-10-15T00:00:01.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
  } as unknown as Message
}

/** N whitelist (Read) tool call/result pairs with `content` in each result. */
function whitelistSession(n: number, content: string): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < n; i++) {
    messages.push(asstWithToolUse(`t${i}`, 'Read'))
    messages.push(userWithToolResult(`t${i}`, content))
  }
  return messages
}

function successPersist(
  capture: string[],
  toolIds: string[] = [],
): ProjectionPersistFn {
  return async (content, toolUseId) => {
    toolIds.push(toolUseId)
    const str =
      typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    capture.push(str)
    return {
      filepath: `/tmp/tool-results/${toolUseId}.txt`,
      originalSize: str.length,
      isJson: false,
      preview: str.slice(0, 2000),
      hasMore: true,
    }
  }
}

const failingPersist: ProjectionPersistFn = async () => ({
  error: 'Permission denied: /tmp/tool-results',
})

// Official Tt wrap constants (_ALL.js:372, mirrored in microCompact.ts).
const ARTIFACT_MARKER_PREFIX = '<artifact-content-authored-by-others/>\n'
const ARTIFACT_MARKER = '<artifact-content-authored-by-others/>'

function toolResultContent(message: Message | undefined): unknown {
  if (!message) return undefined
  const block = (
    message as unknown as {
      message: { content: Array<Record<string, unknown>> }
    }
  ).message.content[0]
  return block.content
}

// ---------------------------------------------------------------------------
// clearToolResultProjection — keepRecent / whitelist / floor / placeholders
// ---------------------------------------------------------------------------

describe('clearToolResultProjection', () => {
  test('keeps exactly 5 whitelist results — nothing cleared', async () => {
    const messages = whitelistSession(5, BIG_CONTENT)
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      failingPersist,
    )
    expect(result).toBeNull()
  })

  test('clears only the oldest beyond the keep-5 window', async () => {
    const messages = whitelistSession(6, BIG_CONTENT)
    const capture: string[] = []
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      successPersist(capture),
    )
    expect(result).not.toBeNull()
    // keepRecent counts whitelist tool_use ids: the last 5 stay.
    expect(result?.clearedToolUseIds).toEqual(['t0'])
    // Cleared block now carries the persisted-output disk-handle guidance.
    expect(String(toolResultContent(result?.messages[1]))).toContain(
      '<persisted-output>',
    )
    expect(String(toolResultContent(result?.messages[1]))).toContain(
      '/tmp/tool-results/t0.txt',
    )
    // The kept last result's content is untouched.
    const lastKept = result?.messages[messages.length - 1]
    expect(toolResultContent(lastKept)).toBe(BIG_CONTENT)
    // Persisted bytes equal the original content byte-for-byte.
    expect(capture).toEqual([BIG_CONTENT])
  })

  test('non-whitelist tools never clear, even when huge', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 30; i++) {
      messages.push(asstWithToolUse(`a${i}`, 'Agent'))
      messages.push(userWithToolResult(`a${i}`, BIG_CONTENT))
    }
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      failingPersist,
    )
    // 0 whitelist ids → nothing clearable → no-op, despite ~1.5M tokens.
    expect(result).toBeNull()
  })

  test('keep-window counts whitelist ids only', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 25; i++) {
      messages.push(asstWithToolUse(`a${i}`, 'Agent'))
      messages.push(userWithToolResult(`a${i}`, BIG_CONTENT))
    }
    for (let i = 0; i < 3; i++) {
      messages.push(asstWithToolUse(`t${i}`, 'Read'))
      messages.push(userWithToolResult(`t${i}`, BIG_CONTENT))
    }
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      failingPersist,
    )
    // 3 whitelist ids, all inside the last-5 window → nothing clearable.
    expect(result).toBeNull()
  })

  test('abandons the whole clear when tokensSaved < 20000', async () => {
    const messages = whitelistSession(6, SMALL_CONTENT)
    let persistCalls = 0
    const persist: ProjectionPersistFn = async () => {
      persistCalls++
      return {
        filepath: '/tmp/x.txt',
        originalSize: 1,
        isJson: false,
        preview: '',
        hasMore: false,
      }
    }
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      persist,
    )
    expect(result).toBeNull()
    // The 20k gross screen fires before any I/O — persist is never reached.
    expect(persistCalls).toBe(0)
  })

  test('executes the clear at exactly the 20k official preview floor', async () => {
    // Official gate is `g < mun` over the GROSS preview Σ Hl (_ALL.js:4544):
    // 80_000 chars → round(80000/4) = 20000 exactly, so the clear EXECUTES.
    // CCH's former post-persist net-basis second gate rejected this exact
    // boundary (对拍报告 boundary_exact_20000, SEMANTIC) — the fix keeps the
    // official single gross gate and demotes net to debug accounting.
    const messages = whitelistSession(6, BIG_CONTENT)
    messages[1] = userWithToolResult('t0', 'a'.repeat(80_000))
    const capture: string[] = []
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      successPersist(capture),
    )
    expect(result).not.toBeNull()
    expect(result?.clearedToolUseIds).toEqual(['t0'])
    // tokensSaved carries the official gross preview basis (g), not net.
    expect(result?.tokensSaved).toBe(20_000)
    expect(capture).toEqual(['a'.repeat(80_000)])
    expect(String(toolResultContent(result?.messages[1]))).toContain(
      '<persisted-output>',
    )
  })

  test('image content reaches persist first (official order), literal wins', async () => {
    // Official :4544 calls persist whenever content is truthy — arrays are
    // always truthy, so image-bearing content reaches persist too (where the
    // real persist path fails on non-text blocks and falls back), then EFt
    // forces the bare literal for visual content regardless of the outcome.
    // CCH formerly split visual content BEFORE persist (对拍报告
    // image_block_bare_literal, EDGE: persistCalls [] vs ['t0']).
    const messages = whitelistSession(6, BIG_CONTENT)
    messages[1] = userWithToolResult('t0', [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      },
      { type: 'text', text: BIG_CONTENT },
    ] as Array<Record<string, unknown>>)
    const capture: string[] = []
    const ids: string[] = []
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      successPersist(capture, ids),
    )
    expect(result).not.toBeNull()
    expect(ids).toEqual(['t0'])
    expect(toolResultContent(result?.messages[1])).toBe(
      TIME_BASED_MC_CLEARED_MESSAGE,
    )
  })

  test('persist failure falls back to the literal placeholder', async () => {
    const messages = whitelistSession(6, BIG_CONTENT)
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      failingPersist,
    )
    expect(result).not.toBeNull()
    expect(toolResultContent(result?.messages[1])).toBe(
      '[Old tool result content cleared]',
    )
  })

  test('artifact-authored content gets the official Tt wrap in the projection', async () => {
    // Official EFt (_ALL.js:4544): when the ORIGINAL content carries the
    // artifact-authored marker and the replacement does not start with the
    // Tt prefix, the replacement is sent as Tt + replacement. CCH's
    // projection formerly omitted the wrap (对拍报告
    // artifact_marker_tt_wrap, LITERAL).
    const marked = `${ARTIFACT_MARKER}\n${BIG_CONTENT}`
    const messages = whitelistSession(6, BIG_CONTENT)
    messages[1] = userWithToolResult('t0', marked)
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      successPersist([]),
    )
    expect(result).not.toBeNull()
    const projected = String(toolResultContent(result?.messages[1]))
    expect(
      projected.startsWith(`${ARTIFACT_MARKER_PREFIX}<persisted-output>`),
    ).toBe(true)
    // clearedReplacements carries exactly the projected (wrapped) string so
    // the query.ts mutable-message sync stays byte-identical.
    expect(result?.clearedReplacements.get('t0')).toBe(projected)
  })

  test('Tt-wrapped cleared literal is recognized as already cleared', async () => {
    // Official zl (_ALL.js:4544) strips an optional Tt prefix and treats the
    // bare literal / persist-preview forms as already-cleared — the Tt-wrapped
    // literal left behind by an earlier clear must not re-enter candidates
    // (对拍报告 tt_prefixed_literal_official_skips, SEMANTIC).
    const wrapped = ARTIFACT_MARKER_PREFIX + '[Old tool result content cleared]'
    const messages: Message[] = [
      asstWithToolUse('t0', 'Read'),
      userWithToolResult('t0', wrapped),
    ]
    for (let i = 1; i <= 6; i++) {
      messages.push(asstWithToolUse(`t${i}`, 'Read'))
      messages.push(userWithToolResult(`t${i}`, BIG_CONTENT))
    }
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      successPersist([]),
    )
    expect(result).not.toBeNull()
    // t0 is zl-skipped; only t1 (outside the keep-5 window) gets cleared.
    expect(result?.clearedToolUseIds).toEqual(['t1'])
    // t0 keeps its already-cleared content untouched.
    expect(toolResultContent(result?.messages[1])).toBe(wrapped)
  })

  test('empty-string result stays a candidate and clears without persist', async () => {
    // Official PLr keeps zero-token results (empty string) as candidates —
    // Hl adds 0 — and the truthy persist check skips the persist call, so
    // E[t0] = bare literal and toolsCleared counts it (对拍报告
    // empty_string_candidate_official_clears, SEMANTIC).
    const messages: Message[] = [
      asstWithToolUse('t0', 'Read'),
      userWithToolResult('t0', ''),
    ]
    for (let i = 1; i <= 6; i++) {
      messages.push(asstWithToolUse(`t${i}`, 'Read'))
      messages.push(userWithToolResult(`t${i}`, BIG_CONTENT))
    }
    const capture: string[] = []
    const ids: string[] = []
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      successPersist(capture, ids),
    )
    expect(result).not.toBeNull()
    expect(result?.clearedToolUseIds).toEqual(['t0', 't1'])
    expect(ids).toEqual(['t1'])
    expect(toolResultContent(result?.messages[1])).toBe(
      TIME_BASED_MC_CLEARED_MESSAGE,
    )
    expect(result?.tokensSaved).toBe(50_000)
  })

  test('text-source document tokens count via the title-extension divisor', async () => {
    // Official Hl routes document blocks through dec0043 Rn: a text-source
    // document counts source.data under the title-extension divisor —
    // 'report.json' → json → 2 → 40_000 chars = 20000 tokens, exactly the
    // official mun floor, so the clear executes (对拍报告
    // document_source_text_token_count, SEMANTIC). Follows persist-first:
    // the visual array reaches persist, fails on the non-text block, and
    // EFt applies the bare literal.
    const messages = whitelistSession(6, BIG_CONTENT)
    messages[1] = userWithToolResult('t0', [
      {
        type: 'document',
        title: 'report.json',
        source: { type: 'text', data: 'y'.repeat(40_000) },
      },
    ] as Array<Record<string, unknown>>)
    const ids: string[] = []
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      successPersist([], ids),
    )
    expect(result).not.toBeNull()
    expect(result?.clearedToolUseIds).toEqual(['t0'])
    expect(result?.tokensSaved).toBe(20_000)
    expect(ids).toEqual(['t0'])
    expect(toolResultContent(result?.messages[1])).toBe(
      TIME_BASED_MC_CLEARED_MESSAGE,
    )
  })

  test('duplicate tool_result blocks persist once per occurrence', async () => {
    // Official PLr candidates are per-block occurrences: a duplicated id
    // counts tokensSaved twice and calls persist twice (E keyed by id, last
    // write wins) — 对拍报告 duplicate_tool_result_ids.
    const messages = whitelistSession(6, BIG_CONTENT)
    messages.splice(2, 0, userWithToolResult('t0', BIG_CONTENT))
    const capture: string[] = []
    const ids: string[] = []
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      successPersist(capture, ids),
    )
    expect(result).not.toBeNull()
    expect(result?.clearedToolUseIds).toEqual(['t0'])
    expect(result?.tokensSaved).toBe(100_000)
    expect(ids).toEqual(['t0', 't0'])
    // Both copies get the same persisted preview in the projection.
    expect(toolResultContent(result?.messages[1])).toContain(
      '<persisted-output>',
    )
  })

  test('projection is non-destructive — inputs stay byte-identical', async () => {
    const messages = whitelistSession(6, BIG_CONTENT)
    const before = JSON.stringify(messages)
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      successPersist([]),
    )
    // The transcript-facing originals are untouched; the clear only produces
    // a new projection (persistent transcript zero-change invariant).
    expect(JSON.stringify(messages)).toBe(before)
    expect(result?.messages).not.toBe(messages)
    expect(result?.messages[1]).not.toBe(messages[1])
  })

  test('declines non-main-thread query sources', async () => {
    const messages = whitelistSession(6, BIG_CONTENT)
    expect(
      await clearToolResultProjection(messages, 'agent:abc' as QuerySource),
    ).toBeNull()
    expect(
      await clearToolResultProjection(messages, 'compact' as QuerySource),
    ).toBeNull()
    expect(await clearToolResultProjection(messages, undefined)).toBeNull()
  })

  test('readFileStatePaths lists Read inputs for cleared ids', async () => {
    const messages: Message[] = [
      asstWithToolUse('t0', 'Read', { file_path: '/tmp/old-file.txt' }),
      userWithToolResult('t0', BIG_CONTENT),
      asstWithToolUse('t1', 'Bash'),
      userWithToolResult('t1', BIG_CONTENT),
      asstWithToolUse('t2', 'Read', { file_path: '/tmp/kept-file.txt' }),
      userWithToolResult('t2', BIG_CONTENT),
      asstWithToolUse('t3', 'Read', { file_path: '/tmp/kept2.txt' }),
      userWithToolResult('t3', BIG_CONTENT),
      asstWithToolUse('t4', 'Read', { file_path: '/tmp/kept3.txt' }),
      userWithToolResult('t4', BIG_CONTENT),
      asstWithToolUse('t5', 'Read', { file_path: '/tmp/kept4.txt' }),
      userWithToolResult('t5', BIG_CONTENT),
    ]
    const result = await clearToolResultProjection(
      messages,
      'repl_main_thread' as QuerySource,
      failingPersist,
    )
    // Only t0 falls outside the keep-5 window; only Read inputs surface.
    expect(result?.readFileStatePaths).toEqual(['/tmp/old-file.txt'])
  })
})

// ---------------------------------------------------------------------------
// Feature flag off (default under bun test) → every path keeps the old behavior
// ---------------------------------------------------------------------------

describe('microcompactMessages (MEMORY_PROJECTION off)', () => {
  test('returns messages unchanged and clears nothing', async () => {
    const messages = whitelistSession(6, BIG_CONTENT)
    const before = JSON.stringify(messages)
    const result = await microcompactMessages(
      messages,
      undefined,
      'repl_main_thread' as QuerySource,
    )
    expect(result.messages).toBe(messages)
    expect(result.clearedToolUseIds).toBeUndefined()
    expect(result.clearedReplacements).toBeUndefined()
    expect(result.readFileStatePaths).toBeUndefined()
    expect(JSON.stringify(messages)).toBe(before)
  })
})
