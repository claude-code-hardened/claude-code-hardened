/**
 * Tests for withRetry.ts fallbackModel trigger plane (official 2.1.284
 * alignment) and the pre-existing 529 fallback regression.
 *
 * Official evidence (docs/reverse-284/full-source/_ALL.js, byte offsets):
 * - trigger condition ~9642757-9642950: model_not_found / permission_denied /
 *   (!persistent && server_error) all switch to fallbackModel on first
 *   occurrence, gated on fallbackModel being configured and != model.
 * - predicates: IUn@9649949 (404+not_found_error+"model:"), Wjt@2687970
 *   (403+permission_error+"model:"), aIe@9650062 (5xx, != 529).
 * - 529 stays budget-based: h0=3 consecutive 529s before fallback.
 *
 * Mock strategy: mock the side-effectful dependency chain (log, debug,
 * bun:bundle, auth, fastMode, analytics) BEFORE dynamically importing the
 * module under test; withRetry itself runs real code paths.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import type Anthropic from '@anthropic-ai/sdk'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

// ── Mocks (before importing the module under test) ──────────────────────────

const featureSet = new Set<string>()
mock.module('bun:bundle', () => ({
  feature: (name: string) => featureSet.has(name),
}))
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

mock.module('src/utils/auth.js', () => ({
  isClaudeAISubscriber: () => false,
  isEnterpriseSubscriber: () => false,
  getClaudeAIOAuthTokens: () => null,
  handleOAuth401Error: async () => {},
  clearApiKeyHelperCache: () => {},
  clearAwsCredentialsCache: () => {},
  clearGcpCredentialsCache: () => {},
}))

mock.module('src/utils/fastMode.js', () => ({
  isFastModeEnabled: () => false,
  isFastModeCooldown: () => false,
  triggerFastModeCooldown: () => {},
  handleFastModeOverageRejection: () => {},
  handleFastModeRejectedByAPI: () => {},
}))

const logEvents: Array<{ name: string; data: Record<string, unknown> }> = []
mock.module('src/services/analytics/index.js', () => ({
  logEvent: (name: string, data?: Record<string, unknown>) => {
    logEvents.push({ name, data: data ?? {} })
  },
}))

// Dynamic import AFTER mocks so withRetry's static imports pick them up.
const {
  withRetry,
  CannotRetryError,
  FallbackTriggeredError,
  isModelNotFoundError,
  isPermissionDeniedError,
  isStatelessServerError,
} = await import('../withRetry.js')

// ── Helpers ─────────────────────────────────────────────────────────────────

type WithRetryOptions = Parameters<typeof withRetry>[2]

function makeOptions(
  overrides: Partial<WithRetryOptions> = {},
): WithRetryOptions {
  return {
    model: 'claude-opus-4-5',
    fallbackModel: 'claude-sonnet-4-5',
    thinkingConfig: { type: 'adaptive' },
    maxRetries: 3,
    querySource: 'repl_main_thread',
    ...overrides,
  }
}

/** APIError whose message mirrors what the API/SDK produces. The predicates
 * match on the embedded error body type plus the model name, so the message
 * carries the JSON body shape. */
function makeApiError(
  status: number,
  errorType: 'not_found_error' | 'permission_error' | 'overloaded_error',
  modelSegment = 'model: claude-opus-4-5',
): APIError {
  const message = `Request failed with ${errorType}: {"type":"error","error":{"type":"${errorType}","message":"${modelSegment}"}}`
  return new APIError(status, {}, message, new Headers())
}

/** Minimal APIError for predicate edge cases (no body/type shape needed). */
function plainApiError(status: number): APIError {
  return new APIError(status, {}, 'e', new Headers())
}

function makeOperation(error: unknown): {
  operation: () => Promise<never>
  getCalls: () => number
} {
  let calls = 0
  return {
    operation: async () => {
      calls++
      throw error
    },
    getCalls: () => calls,
  }
}

const stubGetClient = async (): Promise<Anthropic> =>
  ({}) as unknown as Anthropic

interface DrainResult {
  value?: unknown
  error?: unknown
  yields: number
}

async function drain<T>(
  gen: AsyncGenerator<SystemAPIErrorMessage, T>,
): Promise<DrainResult> {
  const result: DrainResult = { yields: 0 }
  try {
    for (;;) {
      const step = await gen.next()
      if (step.done) {
        result.value = step.value
        return result
      }
      result.yields++
    }
  } catch (error) {
    result.error = error
    return result
  }
}

async function runWithRetry(options: WithRetryOptions, error: unknown) {
  const { operation, getCalls } = makeOperation(error)
  const result = await drain(withRetry(stubGetClient, operation, options))
  return { ...result, calls: getCalls() }
}

// ── Env hygiene ─────────────────────────────────────────────────────────────

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {
    fallbackAll: process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS,
    unattended: process.env.CLAUDE_CODE_UNATTENDED_RETRY,
  }
  logEvents.length = 0
})

afterEach(() => {
  if (savedEnv.fallbackAll === undefined) {
    delete process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS
  } else {
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = savedEnv.fallbackAll
  }
  if (savedEnv.unattended === undefined) {
    delete process.env.CLAUDE_CODE_UNATTENDED_RETRY
  } else {
    process.env.CLAUDE_CODE_UNATTENDED_RETRY = savedEnv.unattended
  }
  featureSet.clear()
})

// ── Pure predicates ─────────────────────────────────────────────────────────

describe('fallback trigger predicates (official IUn/Wjt/aIe alignment)', () => {
  test('isModelNotFoundError matches 404 not_found_error naming the model', () => {
    expect(isModelNotFoundError(makeApiError(404, 'not_found_error'))).toBe(
      true,
    )
  })

  test('isModelNotFoundError rejects 404 without model segment or wrong type', () => {
    expect(
      isModelNotFoundError(
        makeApiError(404, 'not_found_error', 'resource was not found'),
      ),
    ).toBe(false)
    expect(isModelNotFoundError(plainApiError(404))).toBe(false)
    expect(isModelNotFoundError(makeApiError(500, 'not_found_error'))).toBe(
      false,
    )
    expect(isModelNotFoundError(new Error('plain'))).toBe(false)
  })

  test('isPermissionDeniedError matches 403 permission_error naming the model', () => {
    expect(isPermissionDeniedError(makeApiError(403, 'permission_error'))).toBe(
      true,
    )
  })

  test('isPermissionDeniedError rejects 403 without model segment or wrong type', () => {
    expect(
      isPermissionDeniedError(
        makeApiError(403, 'permission_error', 'operation not permitted'),
      ),
    ).toBe(false)
    expect(isPermissionDeniedError(makeApiError(403, 'not_found_error'))).toBe(
      false,
    )
    expect(isPermissionDeniedError(new Error('plain'))).toBe(false)
  })

  test('isStatelessServerError matches 5xx except 529 (official aIe)', () => {
    expect(isStatelessServerError(plainApiError(500))).toBe(true)
    expect(isStatelessServerError(plainApiError(503))).toBe(true)
    expect(isStatelessServerError(plainApiError(529))).toBe(false)
    expect(isStatelessServerError(plainApiError(429))).toBe(false)
    expect(isStatelessServerError(plainApiError(404))).toBe(false)
    expect(isStatelessServerError(plainApiError(600))).toBe(false)
    expect(isStatelessServerError(new Error('plain'))).toBe(false)
  })
})

// ── Fallback trigger plane through withRetry ────────────────────────────────

describe('withRetry fallbackModel trigger plane', () => {
  test('model_not_found triggers fallback on first occurrence', async () => {
    const result = await runWithRetry(
      makeOptions(),
      makeApiError(404, 'not_found_error'),
    )
    expect(result.error).toBeInstanceOf(FallbackTriggeredError)
    const fallback = result.error as FallbackTriggeredError
    expect(fallback.reason).toBe('model_not_found')
    expect(fallback.originalModel).toBe('claude-opus-4-5')
    expect(fallback.fallbackModel).toBe('claude-sonnet-4-5')
    expect(fallback.originalApiError).toBeInstanceOf(APIError)
    expect(result.calls).toBe(1)
    expect(result.yields).toBe(0)
  })

  test('permission_denied triggers fallback on first occurrence', async () => {
    const result = await runWithRetry(
      makeOptions(),
      makeApiError(403, 'permission_error'),
    )
    expect(result.error).toBeInstanceOf(FallbackTriggeredError)
    expect((result.error as FallbackTriggeredError).reason).toBe(
      'permission_denied',
    )
    expect(result.calls).toBe(1)
  })

  test('server_error triggers fallback when fallbackModel configured', async () => {
    const serverError = new APIError(
      500,
      {},
      'Internal server error',
      new Headers(),
    )
    const result = await runWithRetry(makeOptions(), serverError)
    expect(result.error).toBeInstanceOf(FallbackTriggeredError)
    expect((result.error as FallbackTriggeredError).reason).toBe('server_error')
    expect((result.error as FallbackTriggeredError).originalApiError).toBe(
      serverError,
    )
    expect(result.calls).toBe(1)
  })

  test('server_error does not trigger fallback in persistent (watchdog) retry mode', async () => {
    featureSet.add('UNATTENDED_RETRY')
    process.env.CLAUDE_CODE_UNATTENDED_RETRY = '1'
    const serverError = new APIError(
      500,
      {},
      'Internal server error',
      new Headers(),
    )
    const result = await runWithRetry(
      makeOptions({ maxRetries: 0 }),
      serverError,
    )
    expect(result.error).toBeInstanceOf(CannotRetryError)
    expect((result.error as CannotRetryError).originalError).toBe(serverError)
    expect(result.calls).toBe(1)
    expect(result.yields).toBe(0)
  })

  test('without fallbackModel configured, original behavior is preserved', async () => {
    const notFound = makeApiError(404, 'not_found_error')
    const result = await runWithRetry(
      makeOptions({ fallbackModel: undefined }),
      notFound,
    )
    expect(result.error).toBeInstanceOf(CannotRetryError)
    expect((result.error as CannotRetryError).originalError).toBe(notFound)
    expect(result.calls).toBe(1)
  })

  test('fallbackModel equal to model does not trigger fallback', async () => {
    const result = await runWithRetry(
      makeOptions({ fallbackModel: 'claude-opus-4-5' }),
      makeApiError(404, 'not_found_error'),
    )
    expect(result.error).toBeInstanceOf(CannotRetryError)
    expect(result.calls).toBe(1)
  })

  test('model_not_found without model segment in message does not trigger fallback', async () => {
    const result = await runWithRetry(
      makeOptions(),
      makeApiError(404, 'not_found_error', 'resource was not found'),
    )
    expect(result.error).toBeInstanceOf(CannotRetryError)
    expect(result.calls).toBe(1)
  })

  test('permission_denied without model segment in message does not trigger fallback', async () => {
    const result = await runWithRetry(
      makeOptions(),
      makeApiError(403, 'permission_error', 'operation not permitted'),
    )
    expect(result.error).toBeInstanceOf(CannotRetryError)
    expect(result.calls).toBe(1)
  })
})

// ── 529 regression (pre-existing semantics) ─────────────────────────────────

describe('withRetry 529 fallback regression', () => {
  test('three consecutive 529s trigger overloaded fallback after exactly 3 attempts', async () => {
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
    const overloaded = makeApiError(529, 'overloaded_error', 'Overloaded')
    const result = await runWithRetry(
      makeOptions({ maxRetries: 5 }),
      overloaded,
    )
    expect(result.error).toBeInstanceOf(FallbackTriggeredError)
    const fallback = result.error as FallbackTriggeredError
    expect(fallback.reason).toBe('overloaded')
    expect(fallback.originalModel).toBe('claude-opus-4-5')
    expect(result.calls).toBe(3)
    const fallbackEvent = logEvents.find(
      e => e.name === 'tengu_api_opus_fallback_triggered',
    )
    expect(fallbackEvent).toBeDefined()
  })

  test('fewer than three consecutive 529s keeps retrying without fallback', async () => {
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
    const overloaded = makeApiError(529, 'overloaded_error', 'Overloaded')
    const result = await runWithRetry(
      makeOptions({ maxRetries: 0 }),
      overloaded,
    )
    expect(result.error).toBeInstanceOf(CannotRetryError)
    expect((result.error as CannotRetryError).originalError).toBe(overloaded)
    expect(result.calls).toBe(1)
    expect(
      logEvents.find(e => e.name === 'tengu_api_opus_fallback_triggered'),
    ).toBeUndefined()
  })
})
