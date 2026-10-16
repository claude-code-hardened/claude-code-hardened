import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import type { AutoCompactTrackingState } from '../autoCompact.js'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

// -- process-global mocks (bun mock.module is last-write-wins; see
// docs testing spec). Registered BEFORE the dynamic import of the module
// under test; matches the baseline mock set used by
// src/utils/__tests__/tokens.test.ts for the tokens.js dependency chain.
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

// Controllable feature() (default off — bun-test baseline). Set
// setBreakerEnabled(true) to exercise the 2.9 paths.
const flags: Record<string, boolean> = {}
mock.module('bun:bundle', () => ({
  feature: (name: string) => flags[name] ?? false,
}))

// The flags record above only reaches autoCompact.js when this file's
// bun:bundle mock is the live binding of its `feature` import. In a shared
// CI worker, an earlier test file can load autoCompact.js (via the
// query.ts/config.ts/compact.ts import chains) against the REAL bun:bundle
// builtin — a virtual builtin's already-resolved import is not rebound by a
// later mock.module — and then feature() reads the process env directly, so
// every breaker test saw the flag-off path (CI /tmp/test2.log:1140, 1159,
// 1178: prefix-overflow skip never returned, the trip never fired and
// consecutiveRapidRefills came back undefined). Mirror each toggle into the
// real FEATURE_AUTO_COMPACT_BREAKER env var so the gate honors the switch
// under either binding.
function setBreakerEnabled(on: boolean) {
  flags.AUTO_COMPACT_BREAKER = on
  if (on) {
    process.env.FEATURE_AUTO_COMPACT_BREAKER = '1'
  } else {
    delete process.env.FEATURE_AUTO_COMPACT_BREAKER
  }
}

// Telemetry capture for the prefix-overflow / breaker events.
const loggedEvents: Array<{ name: string; data: Record<string, unknown> }> = []
mock.module('src/services/analytics/index.ts', () => ({
  logEvent: (name: string, data: Record<string, unknown>) => {
    loggedEvents.push({ name, data })
  },
}))

// bootstrap/state.ts has module-level realpathSync/randomUUID side effects.
mock.module('src/bootstrap/state.ts', () => ({
  markPostCompaction: () => {},
  getSdkBetas: () => [],
  getStrictToolResultPairing: () => false,
  getSessionId: () => 'test-session',
}))

mock.module('src/utils/config.ts', () => ({
  getGlobalConfig: () => ({ autoCompactEnabled: true }),
}))
// Deterministic window: effective = 1_000_000 - min(32_000, 20_000) = 980_000;
// buffer (>=800k tier) = 50_000 → autocompact threshold = 930_000.
mock.module('src/utils/context.ts', () => ({
  getContextWindowForModel: () => 1_000_000,
}))
mock.module('src/utils/slowOperations.ts', () => ({
  jsonStringify: JSON.stringify,
  jsonParse: JSON.parse,
  // Tagged-template callable returning a Disposable — fsOperations does
  // `using _ = slowLogging\`fs.statSync(...)\``. A plain object here poisons
  // the process-global registry: every later statSync in the shared worker
  // dies with "TypeError: Object is not a function" (CI /tmp/test3.log,
  // NotebookEditTool suite).
  slowLogging: () => ({ [Symbol.dispose]() {} }),
  clone: (v: unknown) => structuredClone(v),
  cloneDeep: (v: unknown) => structuredClone(v),
  callerFrame: () => '',
  SLOW_OPERATION_THRESHOLD_MS: 100,
  writeFileSync_DEPRECATED: () => {},
}))
// Deterministic content estimate: len/bytesPerToken (mirrors the real rough
// estimator). The divisor parameter is load-bearing: sibling compact tests
// (memoryProjection) exercise document blocks through the title-extension
// divisor (json → 2), and a divisor-ignoring len/4 mock here leaks into them
// process-globally (CI /tmp/test2.log:1085 — 40_000/2 became 40_000/4 → the
// 20k floor rejected a boundary-exact case → clearToolResultProjection null).
mock.module('src/services/tokenEstimation.ts', () => ({
  roughTokenCountEstimation: (text: string, bytesPerToken = 4) =>
    Math.round(text.length / bytesPerToken),
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
}))

let compactCalls = 0
mock.module('src/services/api/claude.ts', () => ({
  getMaxOutputTokensForModel: () => 32_000,
}))
mock.module('src/services/analytics/growthbook.ts', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
}))
mock.module('src/services/api/promptCacheBreakDetection.ts', () => ({
  notifyCompaction: () => {},
}))
mock.module('src/services/SessionMemory/sessionMemoryUtils.ts', () => ({
  setLastSummarizedMessageId: () => {},
}))
mock.module('src/services/compact/postCompactCleanup.ts', () => ({
  runPostCompactCleanup: () => {},
}))
mock.module('src/services/compact/sessionMemoryCompact.ts', () => ({
  trySessionMemoryCompaction: async () => null,
}))
mock.module('src/services/compact/compact.ts', () => ({
  compactConversation: async () => {
    compactCalls++
    return {
      summaryMessages: [],
      attachments: [],
      hookResults: [],
      preCompactTokenCount: 0,
      postCompactTokenCount: 0,
      truePostCompactTokenCount: 0,
    }
  },
  ERROR_MESSAGE_USER_ABORT: 'API Error: Request was aborted.',
}))

const {
  detectPrefixOverflow,
  evaluateRapidRefillBreaker,
  autoCompactIfNeeded,
} = await import('../autoCompact.js')

// -- fixtures ---------------------------------------------------------------

let uuidCounter = 0
// Threshold math under the mocks above: window 1M, reservedForSummary 20k
// (min of mocked 32k max-output and the 20k cap) → effective 980k; buffer
// tier >=800k → 50k → AUTO COMPACT THRESHOLD = 930_000.
const THRESHOLD = 930_000

function assistantWithUsage(usage: {
  inputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  outputTokens?: number
}): Message {
  uuidCounter++
  return {
    type: 'assistant',
    uuid: `uuid-asst-${uuidCounter}`,
    timestamp: '2026-10-15T00:00:00.000Z',
    message: {
      id: `msg_${uuidCounter}`,
      role: 'assistant',
      type: 'message',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens ?? 1_000,
        cache_read_input_tokens: usage.cacheReadTokens ?? 0,
        cache_creation_input_tokens: usage.cacheCreationTokens ?? 0,
      },
    },
  } as unknown as Message
}

function userTextMessage(text: string): Message {
  uuidCounter++
  return {
    type: 'user',
    uuid: `uuid-user-${uuidCounter}`,
    timestamp: '2026-10-15T00:00:01.000Z',
    message: { role: 'user', content: text },
  } as unknown as Message
}

function call(
  messages: Message[],
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
) {
  return autoCompactIfNeeded(
    messages,
    {
      options: { mainLoopModel: 'claude-sonnet-4-5' },
    } as unknown as Parameters<typeof autoCompactIfNeeded>[1],
    {} as unknown as Parameters<typeof autoCompactIfNeeded>[2],
    'repl_main_thread' as unknown as Parameters<typeof autoCompactIfNeeded>[3],
    tracking,
    snipTokensFreed,
  )
}

beforeAll(() => {
  delete process.env.DISABLE_COMPACT
  delete process.env.DISABLE_AUTO_COMPACT
  delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
})

afterAll(() => {
  // The real-feature fallback binding reads this env var per call — never
  // leak the ON state into later test files in the same worker.
  delete process.env.FEATURE_AUTO_COMPACT_BREAKER
})

// ---------------------------------------------------------------------------
// detectPrefixOverflow — pure skip decision (official 2.1.284 Oko port)
// ---------------------------------------------------------------------------

describe('detectPrefixOverflow', () => {
  test('returns null when the fixed prefix fits under the threshold', () => {
    // total 100k, message estimate 50k → prefix 50k << 930k
    expect(
      detectPrefixOverflow({
        totalInputTokens: 100_000,
        messagesEstimate: 50_000,
        thresholdTokens: THRESHOLD,
      }),
    ).toBeNull()
  })

  test('returns overflow info when the fixed prefix alone exceeds the threshold', () => {
    // total 990k, message estimate 50k → prefix 940k > 930k
    expect(
      detectPrefixOverflow({
        totalInputTokens: 990_000,
        messagesEstimate: 50_000,
        thresholdTokens: THRESHOLD,
        snipTokensFreed: 0,
      }),
    ).toEqual({
      prefixTokens: 940_000,
      thresholdTokens: THRESHOLD,
      totalInputTokens: 990_000,
      messagesEstimate: 50_000,
      snipTokensFreed: 0,
      documentBlockCount: 0,
      imageBlockCount: 0,
    })
  })

  test('snipTokensFreed shrinks the fixed prefix and can avoid the skip', () => {
    // 990k - 50k - 20k = 920k <= 930k → null
    expect(
      detectPrefixOverflow({
        totalInputTokens: 990_000,
        messagesEstimate: 50_000,
        thresholdTokens: THRESHOLD,
        snipTokensFreed: 20_000,
      }),
    ).toBeNull()
  })

  test('clamps at zero — a tiny usage baseline never reads as overflow', () => {
    expect(
      detectPrefixOverflow({
        totalInputTokens: 10_000,
        messagesEstimate: 50_000,
        thresholdTokens: THRESHOLD,
      }),
    ).toBeNull()
  })

  test('prefix landing exactly on the threshold is not overflow (official w<=D)', () => {
    // 980k usage - 50k message estimate = 930k == threshold → null
    expect(
      detectPrefixOverflow({
        totalInputTokens: 980_000,
        messagesEstimate: 50_000,
        thresholdTokens: THRESHOLD,
      }),
    ).toBeNull()
    // one token over → overflow with the exact Math.max(0, ...) payload
    expect(
      detectPrefixOverflow({
        totalInputTokens: 980_001,
        messagesEstimate: 50_000,
        thresholdTokens: THRESHOLD,
      }),
    ).toEqual({
      prefixTokens: 930_001,
      thresholdTokens: THRESHOLD,
      totalInputTokens: 980_001,
      messagesEstimate: 50_000,
      snipTokensFreed: 0,
      documentBlockCount: 0,
      imageBlockCount: 0,
    })
  })

  test('media counters pass through into the telemetry payload', () => {
    const result = detectPrefixOverflow({
      totalInputTokens: 990_000,
      messagesEstimate: 50_000,
      thresholdTokens: THRESHOLD,
      documentBlockCount: 2,
      imageBlockCount: 5,
    })
    expect(result?.documentBlockCount).toBe(2)
    expect(result?.imageBlockCount).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// evaluateRapidRefillBreaker — count to threshold (official kNn/lFn port)
// ---------------------------------------------------------------------------

describe('evaluateRapidRefillBreaker', () => {
  test('resets to 0 with no tracking, no compact, or elapsed window', () => {
    expect(evaluateRapidRefillBreaker(undefined).consecutiveRapidRefills).toBe(
      0,
    )
    expect(
      evaluateRapidRefillBreaker({
        compacted: false,
        turnCounter: 0,
        turnId: 't',
        consecutiveRapidRefills: 2,
      }).consecutiveRapidRefills,
    ).toBe(0)
    // compacted but 3+ turns since the compact → official kNn resets
    expect(
      evaluateRapidRefillBreaker({
        compacted: true,
        turnCounter: 3,
        turnId: 't',
        consecutiveRapidRefills: 2,
      }).action,
    ).toBe('proceed')
  })

  test('increments (proceed) when refilled within <3 turns', () => {
    const result = evaluateRapidRefillBreaker({
      compacted: true,
      turnCounter: 2,
      turnId: 't',
      consecutiveRapidRefills: 1,
    })
    expect(result).toEqual({ action: 'proceed', consecutiveRapidRefills: 2 })
  })

  test('third consecutive fast refill trips the breaker', () => {
    const result = evaluateRapidRefillBreaker({
      compacted: true,
      turnCounter: 1,
      turnId: 't',
      consecutiveRapidRefills: 2,
    })
    expect(result).toEqual({ action: 'trip', consecutiveRapidRefills: 3 })
  })

  test('qct=3 boundary — turnCounter 2 is the last refill-eligible turn', () => {
    // turnCounter 2 (window is <3) with 2 prior refills → count 3 → trip
    expect(
      evaluateRapidRefillBreaker({
        compacted: true,
        turnCounter: 2,
        turnId: 't',
        consecutiveRapidRefills: 2,
      }),
    ).toEqual({ action: 'trip', consecutiveRapidRefills: 3 })
    // one turn later the official kNn window is closed and resets the count
    expect(
      evaluateRapidRefillBreaker({
        compacted: true,
        turnCounter: 3,
        turnId: 't',
        consecutiveRapidRefills: 2,
      }),
    ).toEqual({ action: 'proceed', consecutiveRapidRefills: 0 })
  })

  test('refill count is orthogonal to consecutiveFailures', () => {
    const result = evaluateRapidRefillBreaker({
      compacted: true,
      turnCounter: 1,
      turnId: 't',
      consecutiveRapidRefills: 1,
      consecutiveFailures: 99,
    })
    expect(result).toEqual({ action: 'proceed', consecutiveRapidRefills: 2 })
    // and the failure breaker metric is untouched by refill arithmetic
    expect(result.consecutiveRapidRefills).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// autoCompactIfNeeded — integration: coexistence, trip, skip, flag-off
// ---------------------------------------------------------------------------

describe('autoCompactIfNeeded (flag off — pre-2.9 regression)', () => {
  test('trip-state tracking is ignored, compact still proceeds', async () => {
    setBreakerEnabled(false)
    compactCalls = 0
    const messages = [
      assistantWithUsage({ inputTokens: 940_000, cacheReadTokens: 10_000 }),
      userTextMessage('a'.repeat(800_000)), // est 200k → count 1.15M >= 930k
    ]
    const result = await call(messages, {
      compacted: true,
      turnId: 't',
      turnCounter: 0,
      consecutiveRapidRefills: 99,
    })
    expect(result.wasCompacted).toBe(true)
    expect(result.consecutiveFailures).toBe(0)
    expect('consecutiveRapidRefills' in result).toBe(false)
    expect('rapidRefillBreaker' in result).toBe(false)
    expect(compactCalls).toBe(1)
  })

  test('failure circuit still opens on consecutiveFailures alone', async () => {
    setBreakerEnabled(false)
    compactCalls = 0
    const messages = [
      assistantWithUsage({ inputTokens: 940_000, cacheReadTokens: 10_000 }),
      userTextMessage('a'.repeat(800_000)),
    ]
    const result = await call(messages, {
      compacted: false,
      turnId: 't',
      turnCounter: 0,
      consecutiveFailures: 3,
    })
    expect(result).toEqual({ wasCompacted: false })
    expect(compactCalls).toBe(0)
  })
})

describe('autoCompactIfNeeded (AUTO_COMPACT_BREAKER on)', () => {
  test('skips when the fixed prefix alone exceeds the threshold', async () => {
    setBreakerEnabled(true)
    loggedEvents.length = 0
    compactCalls = 0
    // usage input+cache = 1_000_000, message content tiny (100 chars → 25
    // est) → prefix ≈ 999_975 >> threshold 930_000.
    const messages = [
      assistantWithUsage({
        inputTokens: 900_000,
        cacheReadTokens: 99_000,
        cacheCreationTokens: 1_000,
      }),
      userTextMessage('a'.repeat(100)),
    ]
    const result = await call(messages, undefined)
    expect(result).toEqual({ wasCompacted: false })
    expect(compactCalls).toBe(0)
    const event = loggedEvents.find(
      e => e.name === 'tengu_auto_compact_prefix_overflow',
    )
    expect(event).toBeDefined()
    expect(event?.data.wouldHaveBlocked).toBe(true)
    expect((event?.data.prefixTokens as number) ?? 0).toBeGreaterThan(THRESHOLD)
  })

  test('prefix fitting the threshold still allows the compact', async () => {
    setBreakerEnabled(true)
    loggedEvents.length = 0
    compactCalls = 0
    // usage total 1_000_000, content estimate 200k → prefix 800k <= 930k;
    // count = 1_000_000 + 200k = 1.2M >= 930k → compacts.
    const messages = [
      assistantWithUsage({ inputTokens: 999_000, cacheReadTokens: 1_000 }),
      userTextMessage('a'.repeat(800_000)),
    ]
    const result = await call(messages, undefined)
    expect(result.wasCompacted).toBe(true)
    expect(result.rapidRefillBreaker).toBeUndefined()
    expect(compactCalls).toBe(1)
    expect(
      loggedEvents.some(e => e.name === 'tengu_auto_compact_prefix_overflow'),
    ).toBe(false)
  })

  test('third consecutive refill within <3 turns trips the breaker', async () => {
    setBreakerEnabled(true)
    loggedEvents.length = 0
    compactCalls = 0
    const messages = [
      assistantWithUsage({ inputTokens: 990_000 }),
      userTextMessage('a'.repeat(800_000)), // prefix → 200k <= 930k, refill OK
    ]
    // official kNn arithmetic: compacted + turnCounter 1 + 2 prior refills
    // → count 3 → lFn "trip".
    const result = await call(messages, {
      compacted: true,
      turnId: 't',
      turnCounter: 1,
      consecutiveRapidRefills: 2,
    })
    expect(result.wasCompacted).toBe(false)
    expect(result.rapidRefillBreaker).toEqual({
      consecutiveRapidRefills: 3,
      turnsSincePreviousCompact: 1,
    })
    expect(compactCalls).toBe(0)
  })

  test('fast refill proceeds and threads the count for re-arm', async () => {
    setBreakerEnabled(true)
    compactCalls = 0
    const messages = [
      assistantWithUsage({ inputTokens: 990_000 }),
      userTextMessage('a'.repeat(800_000)),
    ]
    const result = await call(messages, {
      compacted: true,
      turnId: 't',
      turnCounter: 1,
      consecutiveRapidRefills: 1,
    })
    expect(result.wasCompacted).toBe(true)
    expect(result.consecutiveRapidRefills).toBe(2)
    expect(compactCalls).toBe(1)
  })

  test('failure breaker wins over the refill breaker', async () => {
    setBreakerEnabled(true)
    loggedEvents.length = 0
    compactCalls = 0
    const messages = [
      assistantWithUsage({ inputTokens: 990_000 }),
      userTextMessage('a'.repeat(800_000)),
    ]
    const result = await call(messages, {
      compacted: true,
      turnId: 't',
      turnCounter: 0,
      consecutiveRapidRefills: 9,
      consecutiveFailures: 3,
    })
    // consecutiveFailures >= 3 short-circuits before the refill evaluation.
    expect(result).toEqual({ wasCompacted: false })
    expect('rapidRefillBreaker' in result).toBe(false)
    expect(compactCalls).toBe(0)
    // The refill breaker never evaluated → no refill telemetry.
    expect(loggedEvents.length).toBe(0)
  })
})
