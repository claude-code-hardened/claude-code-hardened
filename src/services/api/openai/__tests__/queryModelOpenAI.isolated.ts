/**
 * Tests for queryModelOpenAI in index.ts.
 *
 * Focused on the two bugs fixed:
 *  1. stop_reason was always null in the assembled AssistantMessage because
 *     partialMessage (from message_start) has stop_reason: null, and the
 *     stop_reason captured from message_delta was never applied.
 *  2. partialMessage was not reset to null after message_stop, so the safety
 *     fallback at the end of the loop would yield a second identical
 *     AssistantMessage (causing doubled content in the next API request).
 *
 * Strategy: mock getOpenAIClient + adaptOpenAIStreamToAnthropic so we can
 * feed pre-built Anthropic events directly into queryModelOpenAI and inspect
 * what it emits — without any real HTTP calls.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  AssistantMessage,
  StreamEvent,
} from '../../../../types/message.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal message_start event */
function makeMessageStart(
  overrides: Record<string, any> = {},
): BetaRawMessageStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides,
    },
  } as any
}

/** Build a content_block_start event for the given block type */
function makeContentBlockStart(
  index: number,
  type: 'text' | 'tool_use' | 'thinking',
  extra: Record<string, any> = {},
): BetaRawMessageStreamEvent {
  const block =
    type === 'text'
      ? { type: 'text', text: '' }
      : type === 'tool_use'
        ? { type: 'tool_use', id: 'toolu_test', name: 'bash', input: {} }
        : { type: 'thinking', thinking: '', signature: '' }
  return {
    type: 'content_block_start',
    index,
    content_block: { ...block, ...extra },
  } as any
}

/** Build a text_delta content_block_delta event */
function makeTextDelta(index: number, text: string): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  } as any
}

/** Build an input_json_delta content_block_delta event */
function makeInputJsonDelta(
  index: number,
  json: string,
): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: json },
  } as any
}

/** Build a thinking_delta content_block_delta event */
function makeThinkingDelta(
  index: number,
  thinking: string,
): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
  } as any
}

/** Build a content_block_stop event */
function makeContentBlockStop(index: number): BetaRawMessageStreamEvent {
  return { type: 'content_block_stop', index } as any
}

/** Build a message_delta event with stop_reason and output_tokens */
function makeMessageDelta(
  stopReason: string,
  outputTokens: number,
): BetaRawMessageStreamEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  } as any
}

/** Build a message_stop event */
function makeMessageStop(): BetaRawMessageStreamEvent {
  return { type: 'message_stop' } as any
}

/** Async generator from a fixed array of events */
async function* eventStream(events: BetaRawMessageStreamEvent[]) {
  for (const e of events) yield e
}

/** Collect all outputs from queryModelOpenAI into typed buckets */
async function runQueryModel(
  events: BetaRawMessageStreamEvent[],
  envOverrides: Record<string, string | undefined> = {},
) {
  // Wire events into the mocked stream adapter
  _nextEvents = events
  // Save + apply env overrides
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  try {
    // We inline mock.module inside the try block.
    // Bun resolves mock.module at the call site synchronously (hoisted),
    // so we register once per test file, then re-import each time.
    const { queryModelOpenAI } = await import('../index.js')

    const assistantMessages: AssistantMessage[] = []
    const streamEvents: StreamEvent[] = []
    const otherOutputs: any[] = []

    const minimalOptions: any = {
      model: 'test-model',
      tools: [],
      agents: [],
      querySource: 'main_loop',
      getToolPermissionContext: async () => ({
        alwaysAllow: [],
        alwaysDeny: [],
        needsPermission: [],
        mode: 'default',
        isBypassingPermissions: false,
      }),
    }

    for await (const item of queryModelOpenAI(
      [],
      { type: 'text', text: '' } as any,
      [],
      new AbortController().signal,
      minimalOptions,
    )) {
      if (item.type === 'assistant') {
        assistantMessages.push(item as AssistantMessage)
      } else if (item.type === 'stream_event') {
        streamEvents.push(item as StreamEvent)
      } else {
        otherOutputs.push(item)
      }
    }

    return { assistantMessages, streamEvents, otherOutputs }
  } finally {
    // Restore env
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// ─── mock setup ──────────────────────────────────────────────────────────────

// We mock at module level. Bun's mock.module replaces the module for the
// entire file, so we configure the stream per-test via a shared variable.
let _nextEvents: BetaRawMessageStreamEvent[] = []
let _searchExtraToolsEnabled = false

/** Captured arguments from the last chat.completions.create() call */
let _lastCreateArgs: Record<string, any> | null = null

/** Captured request options (2nd create() arg — the watchdog signal) */
let _lastCreateOptions: Record<string, any> | null = null

/** In-flight registry snapshot captured inside the mocked create() */
let _inFlightAtCreate: Array<Record<string, any>> = []

/**
 * Establishment attempts that fail with a retryable connection-class error
 * before succeeding. Regression-test injection for the connection-retry
 * replay window (one failing attempt buffers a g0 "Retrying in Xs" row, so
 * the adapted stream exists when the replay yields start).
 */
let _createFailuresRemaining = 0

mock.module('@ant/model-provider', () => ({
  resolveOpenAIModel: (m: string) => m,
  // Faithful stand-in: drain the (wrapped) SDK stream BEFORE emitting the
  // scripted events, exactly like the real adapter iterates its input.
  // Without the drain the watchdog-wrapped generator stays in suspendedStart
  // — generator-return runs no body finallys there, so its in-flight
  // registry entry can never settle and the wiring test leaks by
  // construction.
  adaptOpenAIStreamToAnthropic: async function* (
    _stream: unknown,
    _model: string,
  ) {
    const s = _stream as AsyncIterable<unknown> | undefined
    if (s && typeof (s as any)[Symbol.asyncIterator] === 'function') {
      for await (const _chunk of s) {
        void _chunk
      }
    }
    for (const e of _nextEvents) yield e
  },
  anthropicMessagesToOpenAI: (messages: any[]) =>
    messages.map(msg => ({
      role: msg.message?.role ?? 'user',
      content: msg.message?.content ?? '',
    })),
  anthropicToolsToOpenAI: (tools: any[]) =>
    tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    })),
  anthropicToolChoiceToOpenAI: () => undefined,
  normalizeOpenAIUsage: (params: {
    totalInputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }) => {
    const cacheRead = Math.min(
      Math.max(0, params.cacheReadTokens ?? 0),
      Math.max(0, params.totalInputTokens),
    )
    const remaining = Math.max(0, params.totalInputTokens - cacheRead)
    const cacheCreation = Math.min(
      Math.max(0, params.cacheWriteTokens ?? 0),
      remaining,
    )
    return {
      input_tokens: Math.max(0, remaining - cacheCreation),
      output_tokens: Math.max(0, params.outputTokens),
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
    }
  },
}))

mock.module('../../../../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: unknown) =>
    fallback,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getFeatureValue_CACHED_WITH_REFRESH: (_key: string, fallback: unknown) =>
    fallback,
}))

// Force Chat Completions path so stream/client mocks apply (not Responses).
// Avoid partial mocks of bootstrap/state and envUtils — incomplete surfaces
// break transitive named imports when this file is run alone.
mock.module('../chatgptAuth.js', () => ({
  isChatGPTAuthEnabled: () => false,
  getValidChatGPTAuth: async () => null,
  // W2.4 invalidate 面：responsesAdapter 的 invalidateCachedCodexClient
  // 依赖该绑定（真实 responsesAdapter 与本 mock 链接）；本文件强制走
  // Chat Completions 路径，空实现。
  invalidateChatGPTTokenCache: () => {},
}))

mock.module('bun:bundle', () => ({
  feature: () => false,
}))

mock.module('../client.js', () => ({
  getOpenAIClient: () => ({
    baseURL: 'https://relay.test/v1',
    chat: {
      completions: {
        create: async (
          args: Record<string, any>,
          options?: Record<string, any>,
        ) => {
          if (_createFailuresRemaining > 0) {
            _createFailuresRemaining--
            throw Object.assign(new Error('relay connect ECONNREFUSED'), {
              code: 'ECONNREFUSED',
            })
          }
          _lastCreateArgs = args
          _lastCreateOptions = options ?? null
          const { getInFlightApiRequests } = await import(
            '../streamWatchdog.js'
          )
          _inFlightAtCreate = getInFlightApiRequests().map(entry => ({
            ...entry,
          }))
          return { [Symbol.asyncIterator]: async function* () {} }
        },
      },
    },
  }),
}))

mock.module('../streamAdapter.js', () => ({
  adaptOpenAIStreamToAnthropic: (_stream: any, _model: string) =>
    eventStream(_nextEvents),
}))

mock.module('../modelMapping.js', () => ({
  resolveOpenAIModel: (m: string) => m,
}))

mock.module('../convertMessages.js', () => ({
  anthropicMessagesToOpenAI: () => [],
}))

mock.module('../convertTools.js', () => ({
  anthropicToolsToOpenAI: () => [],
  anthropicToolChoiceToOpenAI: () => undefined,
}))

mock.module('../../../../utils/context.js', () => ({
  MODEL_CONTEXT_WINDOW_DEFAULT: 200_000,
  COMPACT_MAX_OUTPUT_TOKENS: 20_000,
  CAPPED_DEFAULT_MAX_TOKENS: 8_000,
  ESCALATED_MAX_TOKENS: 64_000,
  is1mContextDisabled: () => false,
  has1mContext: () => false,
  modelSupports1M: () => false,
  getModelMaxOutputTokens: () => ({ upperLimit: 8192, default: 8192 }),
  getContextWindowForModel: () => 200_000,
  getSonnet1mExpTreatmentEnabled: () => false,
  calculateContextPercentages: () => ({
    usedPercent: 0,
    remainingPercent: 100,
  }),
  getMaxThinkingTokensForModel: () => 0,
}))

mock.module('../../../../utils/messages.js', () => ({
  normalizeMessagesForAPI: (msgs: any) => msgs,
  normalizeContentFromAPI: (blocks: any[]) => blocks,
  createUserMessage: (opts: any) => ({
    type: 'user',
    message: { role: 'user', content: opts.content },
    uuid: 'user-uuid',
    timestamp: new Date().toISOString(),
    isMeta: opts.isMeta,
  }),
  createAssistantAPIErrorMessage: (opts: any) => ({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: opts.content }],
      apiError: opts.apiError,
    },
    uuid: 'error-uuid',
    timestamp: new Date().toISOString(),
  }),
}))

mock.module('../../../../utils/api.js', () => ({
  toolToAPISchema: async (t: any) => t,
}))

mock.module('../../../../utils/searchExtraTools.js', () => ({
  isSearchExtraToolsEnabled: async () => _searchExtraToolsEnabled,
  extractDiscoveredToolNames: () => new Set(),
  isDeferredToolsDeltaEnabled: () => false,
}))

mock.module('../../../../tools/SearchExtraToolsTool/prompt.js', () => ({
  isDeferredTool: () => false,
  SEARCH_EXTRA_TOOLS_TOOL_NAME: '__tool_search__',
}))

mock.module('../../../../cost-tracker.js', () => ({
  addToTotalSessionCost: () => {},
}))

mock.module('../../../../utils/modelCost.js', () => ({
  COST_TIER_3_15: {},
  COST_TIER_15_75: {},
  COST_TIER_5_25: {},
  COST_TIER_30_150: {},
  COST_HAIKU_35: {},
  COST_HAIKU_45: {},
  getOpus46CostTier: () => ({}),
  MODEL_COSTS: {},
  getModelCosts: () => ({}),
  calculateUSDCost: () => 0,
  calculateCostFromTokens: () => 0,
  formatModelPricing: () => '',
  getModelPricingString: () => undefined,
}))

mock.module('src/services/langfuse/tracing.ts', () => ({
  createTrace: () => null,
  recordLLMObservation: () => {},
  recordToolObservation: () => {},
  createToolBatchSpan: () => null,
  endToolBatchSpan: () => {},
  createSubagentTrace: () => null,
  createChildSpan: () => null,
  endTrace: () => {},
}))

mock.module('../../../../services/langfuse/convert.js', () => ({
  convertMessagesToLangfuse: () => [],
  convertOutputToLangfuse: () => ({}),
  convertToolsToLangfuse: () => [],
}))

mock.module('../../../../utils/debug.js', () => ({
  logForDebugging: () => {},
  logAntError: () => {},
  isDebugMode: () => false,
  isDebugToStdErr: () => false,
  getDebugFilePath: () => null,
  getDebugLogPath: () => '',
  getDebugFilter: () => null,
  getMinDebugLogLevel: () => 'debug',
  enableDebugLogging: () => false,
  setHasFormattedOutput: () => {},
  getHasFormattedOutput: () => false,
  flushDebugLogs: async () => {},
}))

// ─── tests ───────────────────────────────────────────────────────────────────

describe('queryModelOpenAI — stop_reason propagation', () => {
  test('assembled AssistantMessage has stop_reason end_turn (not null)', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'Hello'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 10),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.message.stop_reason).toBe('end_turn')
  })

  test('assembled AssistantMessage has stop_reason tool_use', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'tool_use'),
      makeInputJsonDelta(0, '{"cmd":"ls"}'),
      makeContentBlockStop(0),
      makeMessageDelta('tool_use', 20),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.message.stop_reason).toBe('tool_use')
  })

  test('assembled AssistantMessage has stop_reason max_tokens', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'truncated'),
      makeContentBlockStop(0),
      makeMessageDelta('max_tokens', 8192),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    // Two assistant-typed items: the content message + the max_output_tokens error signal.
    // The error signal is emitted as a synthetic assistant message by createAssistantAPIErrorMessage.
    expect(assistantMessages).toHaveLength(2)
    const contentMsg = assistantMessages[0]!
    expect(contentMsg.message.stop_reason).toBe('max_tokens')
    // Second item is the error signal (has apiError set)
    const errorMsg = assistantMessages[1]!.message as any
    expect(errorMsg.apiError).toBe('max_output_tokens')
  })

  test('stop_reason is null when no message_delta was received (safety fallback path)', async () => {
    // Stream ends without message_stop — triggers the safety fallback branch.
    // stop_reason stays null since no message_delta was ever seen.
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'partial'),
      makeContentBlockStop(0),
      // No message_delta / message_stop
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    // Safety fallback should yield the partial content
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.message.stop_reason).toBeNull()
  })
})

describe('queryModelOpenAI — usage accumulation', () => {
  test('usage in assembled message reflects all four fields from message_delta', async () => {
    // message_start has all fields=0 (trailing-chunk pattern: usage not yet available).
    // message_delta carries the real values after stream ends.
    // The spread in the message_delta handler must override all zeros from message_start,
    // including cache_read_input_tokens which was previously missing from message_delta.
    _nextEvents = [
      makeMessageStart({
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'response'),
      makeContentBlockStop(0),
      // message_delta carries all four Anthropic usage fields (as emitted by the fixed streamAdapter)
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: 30011,
          output_tokens: 190,
          cache_read_input_tokens: 19904,
          cache_creation_input_tokens: 0,
        },
      } as any,
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    const usage = assistantMessages[0]!.message.usage as any
    expect(usage.input_tokens).toBe(30011)
    expect(usage.output_tokens).toBe(190)
    // cache_read_input_tokens from message_delta overrides the 0 from message_start
    expect(usage.cache_read_input_tokens).toBe(19904)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })

  test('usage is zero when no usage events arrive (prevents false autocompact)', async () => {
    // If usage stays 0, tokenCountWithEstimation will undercount — so at least
    // verify the field exists and is numeric (to detect regressions).
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hi'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 0),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    const usage = assistantMessages[0]!.message.usage as any
    expect(typeof usage.input_tokens).toBe('number')
    expect(typeof usage.output_tokens).toBe('number')
  })
})

describe('queryModelOpenAI — no duplicate AssistantMessage (partialMessage reset)', () => {
  test('yields exactly one AssistantMessage per message_stop when content is present', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'only once'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    // Before the fix, partialMessage was not reset to null, so the safety
    // fallback at the end of the loop would yield a second message with the
    // same message.id — causing mergeAssistantMessages to concatenate content.
    expect(assistantMessages).toHaveLength(1)
  })

  test('thinking + text response yields exactly one AssistantMessage', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'thinking'),
      makeThinkingDelta(0, 'let me think'),
      makeContentBlockStop(0),
      makeContentBlockStart(1, 'text'),
      makeTextDelta(1, 'answer'),
      makeContentBlockStop(1),
      makeMessageDelta('end_turn', 30),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
  })

  test('safety fallback path still yields message when stream ends without message_stop', async () => {
    // Simulates a stream that cuts off without the normal termination sequence.
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'abrupt end'),
      // No content_block_stop, no message_delta, no message_stop
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
  })
})

describe('queryModelOpenAI — stream_events forwarded', () => {
  test('every adapted event is also yielded as stream_event for real-time display', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hello'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    const { streamEvents } = await runQueryModel(_nextEvents)

    const eventTypes = streamEvents.map(e => (e as any).event?.type)
    expect(eventTypes).toContain('message_start')
    expect(eventTypes).toContain('content_block_start')
    expect(eventTypes).toContain('content_block_delta')
    expect(eventTypes).toContain('content_block_stop')
    expect(eventTypes).toContain('message_delta')
    expect(eventTypes).toContain('message_stop')
  })
})

describe('queryModelOpenAI — max_tokens forwarded to request', () => {
  test('official OpenAI requests include max_tokens and a session cache key', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hi'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    // Hermetic: force the OFFICIAL endpoint determination — a host/base-URL
    // env exported by the surrounding environment (local relays) must not
    // downgrade this test to the compatible-provider keying.
    await runQueryModel(_nextEvents, { OPENAI_BASE_URL: undefined })

    expect(_lastCreateArgs).not.toBeNull()
    expect(_lastCreateArgs!.max_tokens).toBe(8192)
    expect(_lastCreateArgs!.prompt_cache_key).toStartWith('cch:')
  })

  test('compatible providers do not receive OpenAI cache parameters', async () => {
    _nextEvents = [makeMessageStart(), makeMessageStop()]

    await runQueryModel(_nextEvents, {
      OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
    })

    expect(_lastCreateArgs).not.toBeNull()
    expect('prompt_cache_key' in _lastCreateArgs!).toBe(false)
  })
})

describe('queryModelOpenAI — stream watchdog wiring', () => {
  test('passes the watchdog abort signal to chat.completions.create', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeMessageDelta('end_turn', 3),
      makeMessageStop(),
    ]

    await runQueryModel(_nextEvents)

    expect(_lastCreateOptions).not.toBeNull()
    const passedSignal = _lastCreateOptions!.signal
    expect(passedSignal).toBeInstanceOf(AbortSignal)
    expect((passedSignal as AbortSignal).aborted).toBe(false)
  })

  test('registers the in-flight request before create() and settles it after the stream ends', async () => {
    const { getInFlightApiRequests } = await import('../streamWatchdog.js')
    const before = getInFlightApiRequests().length

    _nextEvents = [
      makeMessageStart(),
      makeMessageDelta('end_turn', 3),
      makeMessageStop(),
    ]
    await runQueryModel(_nextEvents)

    // Registered at "started": the entry already exists when create() fires.
    expect(_inFlightAtCreate).toHaveLength(1)
    expect(_inFlightAtCreate[0]!.model).toBe('test-model')
    expect(_inFlightAtCreate[0]!.url).toBe(
      'https://relay.test/v1/chat/completions',
    )
    expect(_inFlightAtCreate[0]!.startedAt).toBeGreaterThan(0)

    // Consumed to completion — the wrapped stream's finally must have
    // settled the entry (registry returns to its pre-run size).
    expect(getInFlightApiRequests().length).toBe(before)
  })
})

describe('queryModelOpenAI — deferred MCP tool visibility', () => {
  test('prepends available deferred MCP tools to OpenAI messages', async () => {
    _searchExtraToolsEnabled = true
    _nextEvents = [makeMessageStart(), makeMessageStop()]

    try {
      const { queryModelOpenAI } = await import('../index.js')
      const tools: any[] = [
        {
          name: 'SearchExtraTools',
          isMcp: false,
          input_schema: { type: 'object', properties: {} },
          prompt: async () => 'Search deferred tools',
        },
        {
          name: 'mcp__wechat__send_message',
          isMcp: true,
          input_schema: { type: 'object', properties: {} },
          prompt: async () => 'Send a WeChat message',
        },
      ]

      const options: any = {
        model: 'test-model',
        tools: [],
        agents: [],
        querySource: 'main_loop',
        getToolPermissionContext: async () => ({
          alwaysAllow: [],
          alwaysDeny: [],
          needsPermission: [],
          mode: 'default',
          isBypassingPermissions: false,
        }),
      }

      for await (const _item of queryModelOpenAI(
        [],
        { type: 'text', text: '' } as any,
        tools as any,
        new AbortController().signal,
        options,
      )) {
        // Exhaust generator so request body is built.
      }

      expect(_lastCreateArgs).not.toBeNull()
      expect(JSON.stringify(_lastCreateArgs!.messages)).toContain(
        '<available-deferred-tools>\\nmcp__wechat__send_message\\n</available-deferred-tools>',
      )
    } finally {
      _searchExtraToolsEnabled = false
    }
  })
})

// ─── #31 residual orphan window: teardown guard on the replay window ─────────
//
// The establishment-retry rows are REPLAYED via yields after `adaptedStream`
// exists but before the consumption for-await starts. A consumer .return()
// at that suspension used to unwind with no enclosing finally reaching the
// stream — the provider-concurrency slot and the watchdog in-flight registry
/// leaked and the raw HTTP body hung. The teardown guard closes the adapted
// chain on that path.

describe('queryModelOpenAI — replay-window teardown guard (#31 orphan window)', () => {
  test('consumer .return() during the retry-notice replay releases the provider slot and settles the watchdog', async () => {
    const { getProviderConcurrencyState, resetProviderConcurrencyForTest } =
      await import('../../../../services/api/providerConcurrency.js')
    const { getInFlightApiRequests } = await import('../streamWatchdog.js')
    resetProviderConcurrencyForTest()

    const inFlightBefore = getInFlightApiRequests().length

    // Attempt 1 fails with a retryable connection error (buffers one g0
    // "Retrying in Xs" row); attempt 2 succeeds — the adapted stream exists
    // while the buffered rows are replayed.
    _createFailuresRemaining = 1
    _nextEvents = []

    try {
      const { queryModelOpenAI } = await import('../index.js')
      const options: any = {
        model: 'test-model',
        tools: [],
        agents: [],
        querySource: 'main_loop',
        getToolPermissionContext: async () => ({
          alwaysAllow: [],
          alwaysDeny: [],
          needsPermission: [],
          mode: 'default',
          isBypassingPermissions: false,
        }),
      }

      const gen = queryModelOpenAI(
        [],
        { type: 'text', text: '' } as any,
        [],
        new AbortController().signal,
        options,
      )

      // First pull lands on a replayed retry notice — the generator is now
      // suspended at the hazard point (adaptedStream exists, for-await not
      // started, no enclosing finally in the pre-fix code).
      const first = await gen.next()
      expect(first.done).toBe(false)
      const notice = first.value as any
      expect(notice.type).toBe('system')
      expect(notice.subtype).toBe('api_error')
      expect(notice.retryAttempt).toBe(1)

      // The request is in flight and holds its slot at this point.
      expect(getProviderConcurrencyState('openai')?.active).toBe(1)
      expect(getInFlightApiRequests().length).toBe(inFlightBefore + 1)

      // Abandon mid-replay — the exact pre-fix leak path.
      await gen.return(undefined)

      // Teardown travels through fire-and-forget microtask chains
      // (return() → releaseOnStreamEnd finally → watchdog settle) — poll
      // briefly instead of asserting synchronously.
      for (let i = 0; i < 200; i++) {
        const state = getProviderConcurrencyState('openai')
        if (
          (state?.active ?? 1) === 0 &&
          getInFlightApiRequests().length === inFlightBefore
        ) {
          break
        }
        await Bun.sleep(5)
      }
      expect(getProviderConcurrencyState('openai')?.active).toBe(0)
      expect(getInFlightApiRequests().length).toBe(inFlightBefore)
    } finally {
      _createFailuresRemaining = 0
    }
  })

  test('replay followed by normal consumption still streams fully (guard must not close early)', async () => {
    const { getProviderConcurrencyState, resetProviderConcurrencyForTest } =
      await import('../../../../services/api/providerConcurrency.js')
    resetProviderConcurrencyForTest()
    _createFailuresRemaining = 1
    try {
      // Consumed to completion — the slot is released by the normal path
      // (the guard stayed idle: replayed=true, no early close). A text block
      // must be present so the message_stop assembly yields one assistant.
      _nextEvents = [
        makeMessageStart(),
        makeContentBlockStart(0, 'text'),
        makeTextDelta(0, 'Hello'),
        makeContentBlockStop(0),
        makeMessageDelta('end_turn', 3),
        makeMessageStop(),
      ]
      const { assistantMessages } = await runQueryModel(_nextEvents)
      expect(assistantMessages).toHaveLength(1)
      expect(assistantMessages[0]!.message.stop_reason).toBe('end_turn')
      // Consumed to completion — the slot is released by the normal path
      // (the guard stayed idle: replayed=true, no early close).
      expect(getProviderConcurrencyState('openai')?.active).toBe(0)
    } finally {
      _createFailuresRemaining = 0
    }
  })
})
