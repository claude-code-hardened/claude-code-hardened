import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'

// logForDebugging writes are irrelevant to these semantics tests; mock the
// shared debug module before the module under test loads (tests/mocks convention).
mock.module('src/utils/debug.ts', debugMock)

import {
  isProviderConnectionRetryable,
  withConnectionRetry,
} from '../connectionRetry.js'

describe('isProviderConnectionRetryable', () => {
  test('user abort (signal aborted) is never retryable', () => {
    const controller = new AbortController()
    controller.abort()
    expect(
      isProviderConnectionRetryable(
        new Error('Request timed out'),
        controller.signal,
      ),
    ).toBe(false)
  })

  test('connection-class errors are retryable', () => {
    const reset = Object.assign(new Error('socket reset'), {
      code: 'ECONNRESET',
    })
    expect(isProviderConnectionRetryable(reset)).toBe(true)

    const invalid = Object.assign(
      new Error(
        'InvalidHTTPResponse fetching "http://127.0.0.1:17892/v1/chat/completions"',
      ),
      { name: 'ConnectionError' },
    )
    expect(isProviderConnectionRetryable(invalid)).toBe(true)

    const timeout = Object.assign(new Error('operation timed out'), {
      name: 'TimeoutError',
    })
    expect(isProviderConnectionRetryable(timeout)).toBe(true)
  })

  test('x-should-retry header has veto power', () => {
    const veto = Object.assign(new Error('server says no'), {
      status: 500,
      headers: { 'x-should-retry': 'false' },
    })
    expect(isProviderConnectionRetryable(veto)).toBe(false)

    const allow = Object.assign(new Error('server says retry'), {
      status: 400,
      headers: { 'x-should-retry': 'true' },
    })
    expect(isProviderConnectionRetryable(allow)).toBe(true)
  })

  test('40x statuses are not retryable, 408/429/5xx are', () => {
    expect(isProviderConnectionRetryable({ status: 400 })).toBe(false)
    expect(isProviderConnectionRetryable({ status: 404 })).toBe(false)
    expect(isProviderConnectionRetryable({ status: 408 })).toBe(true)
    expect(isProviderConnectionRetryable({ status: 429 })).toBe(true)
    expect(isProviderConnectionRetryable({ status: 500 })).toBe(true)
  })

  test('watchdog establishment stall (APIUserAbortError, signal live) is retryable', () => {
    // Per-attempt watchdog fired during establishment: the SDK surfaces an
    // abort the signal never requested — user aborts are pre-filtered by
    // the signal check, so this shape is always a timeout-class failure.
    class APIUserAbortError extends Error {}
    const stall = Object.assign(new APIUserAbortError('Request was aborted.'), {
      name: 'APIUserAbortError',
    })
    expect(isProviderConnectionRetryable(stall)).toBe(true)
  })

  test('openai 7.x abort shape: constructor.name identity, instance name is bare Error', () => {
    // openai SDK 7.34 never sets the instance `name` — classification must
    // read the constructor chain, not `error.name`.
    class APIUserAbortError extends Error {}
    const stall = new APIUserAbortError('Request was aborted.')
    // Simulate the SDK: construct prop intact, name never personalized.
    expect((stall as { name: string }).name).toBe('Error')
    delete (stall as { name?: string }).name
    expect(isProviderConnectionRetryable(stall)).toBe(true)
  })

  test('genai abort shape (plain Error + request-was-aborted message)', () => {
    const genaiAbort = new Error('Request was aborted.')
    expect(isProviderConnectionRetryable(genaiAbort)).toBe(true)
  })

  test('fail-closed re-wraps survive via the cause chain (codex path)', () => {
    // responsesAdapter re-wraps establishment errors into a plain Error with
    // the original riding in `cause` — classification must see through it.
    const rewrapped = new Error('ChatGPT Responses API request failed (429)', {
      cause: Object.assign(new Error('Request timed out.'), {
        status: 429,
        headers: { 'x-should-retry': 'true' },
      }),
    })
    expect(isProviderConnectionRetryable(rewrapped)).toBe(true)

    const vetoedRewrap = new Error(
      'ChatGPT Responses API request failed (401)',
      {
        cause: {
          status: 401,
          headers: { 'x-should-retry': 'false' },
          message: 'unauthorized',
        },
      },
    )
    expect(isProviderConnectionRetryable(vetoedRewrap)).toBe(false)

    const resetRewrap = new Error(
      'ChatGPT Responses API request failed (undefined)',
      {
        cause: Object.assign(new Error('socket hang up'), {
          code: 'ECONNRESET',
        }),
      },
    )
    expect(isProviderConnectionRetryable(resetRewrap)).toBe(true)

    const timeoutRewrap = new Error(
      'ChatGPT Responses API request failed (undefined)',
      { cause: new Error('Request timed out') },
    )
    expect(isProviderConnectionRetryable(timeoutRewrap)).toBe(true)
  })
})

describe('withConnectionRetry', () => {
  test('retries connection-class failures and succeeds within budget', async () => {
    let attempts = 0
    const result = await withConnectionRetry(
      async () => {
        attempts++
        if (attempts < 3) {
          throw Object.assign(new Error('reset by peer'), {
            code: 'ECONNRESET',
          })
        }
        return 'ok'
      },
      { sleep: async () => {} },
    )
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  test('terminal error keeps its original class after budget exhausts', async () => {
    const terminal = Object.assign(new Error('relay gone'), {
      code: 'ECONNREFUSED',
    })
    let attempts = 0
    await expect(
      withConnectionRetry(
        async () => {
          attempts++
          throw terminal
        },
        { maxRetries: 2, sleep: async () => {} },
      ),
    ).rejects.toBe(terminal)
    // 1 initial + 2 retries — official maxRetries ?? 2 semantics
    expect(attempts).toBe(3)
  })

  test('user abort escapes immediately without retries', async () => {
    const controller = new AbortController()
    controller.abort()
    let attempts = 0
    await expect(
      withConnectionRetry(
        async () => {
          attempts++
          throw new Error('aborted')
        },
        { signal: controller.signal, sleep: async () => {} },
      ),
    ).rejects.toThrow('aborted')
    expect(attempts).toBe(1)
  })

  test('non-retryable status escapes on first attempt', async () => {
    let attempts = 0
    await expect(
      withConnectionRetry(
        async () => {
          attempts++
          throw Object.assign(new Error('bad request'), { status: 400 })
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('bad request')
    expect(attempts).toBe(1)
  })

  test('retry-after-ms header merges as max(header, base) per official XD', async () => {
    const sleeps: number[] = []
    let attempts = 0
    await withConnectionRetry(
      async () => {
        attempts++
        if (attempts === 1) {
          throw Object.assign(new Error('rate limited'), {
            status: 429,
            headers: { 'retry-after-ms': '250' },
          })
        }
        return 'ok'
      },
      { sleep: async ms => void sleeps.push(ms) },
    )
    // official XD: max(retry-after, round(base·(1+rand·0.25))) — base at
    // attempt 1 is 500ms, so a smaller 250ms header cannot win the max.
    expect(sleeps.length).toBe(1)
    expect(sleeps[0]!).toBeGreaterThanOrEqual(500)
    expect(sleeps[0]!).toBeLessThanOrEqual(630)

    // a larger header (5s) does win the max
    const big: number[] = []
    let tries = 0
    await withConnectionRetry(
      async () => {
        tries++
        if (tries === 1) {
          throw Object.assign(new Error('rate limited'), {
            status: 429,
            headers: { 'retry-after-ms': '5000' },
          })
        }
        return 'ok'
      },
      { sleep: async ms => void big.push(ms) },
    )
    expect(big).toEqual([5000])
  })

  test('default backoff honors the official curve (bounded, jittered)', async () => {
    const sleeps: number[] = []
    let attempts = 0
    await withConnectionRetry(
      async () => {
        attempts++
        if (attempts <= 6) {
          throw new Error('connection timed out')
        }
        return 'ok'
      },
      { maxRetries: 6, sleep: async ms => void sleeps.push(ms) },
    )
    // attempt N delay = round(min(0.5 * 2^(N-1), 20s) * (1 + rand*0.25)) —
    // official XD formula: additive jitter UP 0~+25%, cap 20s (nIe=20000)
    const base = [500, 1000, 2000, 4000, 8000, 16000]
    expect(sleeps.length).toBe(6)
    sleeps.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(base[i]!)
      expect(ms).toBeLessThanOrEqual(Math.round(base[i]! * 1.26))
    })
  })
})
