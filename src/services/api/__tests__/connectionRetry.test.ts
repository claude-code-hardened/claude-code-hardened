import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'

// logForDebugging writes are irrelevant to these semantics tests; mock the
// shared debug module before the module under test loads (tests/mocks convention).
mock.module('src/utils/debug.ts', debugMock)

import type { ConnectionRetryStatus } from '../connectionRetry.js'
import {
  isProviderConnectionRetryable,
  resolveConnectionMaxRetries,
  resolveUnavailableOuterRetries,
  RetryAfterTooLongError,
  withConnectionRetry,
} from '../connectionRetry.js'

/** Restore one env var after a test (undefined → unset). */
function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key]
  else process.env[key] = previous
}

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

  test('retry-after header fully overrides the curve (0032 retryRequest)', async () => {
    const sleeps: number[] = []
    let attempts = 0
    await withConnectionRetry(
      async () => {
        attempts++
        if (attempts === 1) {
          // 非 429（建立面）：retryRequest 脸面保留（0032 原文头字段全量
          // 覆盖）。429 已改走 XD 循环层曲线（见 retry gate describe）。
          throw Object.assign(new Error('service unavailable'), {
            status: 503,
            headers: { 'retry-after-ms': '250' },
          })
        }
        return 'ok'
      },
      { sleep: async ms => void sleeps.push(ms) },
    )
    // 0032 retryRequest: the header wins outright — `if (o === void 0)`
    // guards the computed default, never a max(header, base) merge. The
    // 250ms header must survive even though the attempt-1 curve is 500ms.
    expect(sleeps).toEqual([250])

    // a larger header (5s) likewise passes through untouched
    const big: number[] = []
    let tries = 0
    await withConnectionRetry(
      async () => {
        tries++
        if (tries === 1) {
          throw Object.assign(new Error('service unavailable'), {
            status: 503,
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
    // 0032 calculateDefaultRetryTimeoutMillis: attempt N delay =
    // min(0.5 * 2^(N-1), 8s) * (1 - rand*0.25) — downward-only jitter,
    // SDK-layer cap 8s (not the 20s wrapper constant).
    const base = [500, 1000, 2000, 4000, 8000, 8000]
    expect(sleeps.length).toBe(6)
    sleeps.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(Math.round(base[i]! * 0.75))
      expect(ms).toBeLessThanOrEqual(base[i]!)
    })
  })

  test('onRetryStatus reports the official payload per retry', async () => {
    const notices: ConnectionRetryStatus[] = []
    let attempts = 0
    // 非 429 类（建立面 0032 retryRequest 曲线 [375,500]）；429 的 payload
    // 面走 XD 曲线（retry gate describe 单测）。
    const failure = Object.assign(new Error('throttled'), { status: 503 })
    await withConnectionRetry(
      async () => {
        attempts++
        if (attempts === 1) throw failure
        return 'ok'
      },
      {
        maxRetries: 3,
        sleep: async () => {},
        onRetryStatus: s => void notices.push(s),
      },
    )
    expect(notices.length).toBe(1)
    expect(notices[0]!.attempt).toBe(1)
    expect(notices[0]!.maxRetries).toBe(3)
    // 0032 curve at attempt 1: 500ms * (1 - rand*0.25) → [375, 500]
    expect(notices[0]!.retryInMs).toBeGreaterThanOrEqual(375)
    expect(notices[0]!.retryInMs).toBeLessThanOrEqual(500)
    // official module-006 payload: {kind:'retrying', error, deadline}
    expect(notices[0]!.kind).toBe('retrying')
    expect(notices[0]!.error).toBe(failure)
    expect(typeof notices[0]!.deadline).toBe('number')
    expect(notices[0]!.deadline).toBeGreaterThan(0)
  })
})

describe('resolveConnectionMaxRetries (official cIe chain)', () => {
  test('env unset + watchdog off → official EEo=10 floor', () => {
    expect(resolveConnectionMaxRetries(undefined, {})).toBe(10)
  })

  test('env unset + retry watchdog on → official REo=300', () => {
    expect(
      resolveConnectionMaxRetries(undefined, {
        CLAUDE_CODE_RETRY_WATCHDOG: '1',
      }),
    ).toBe(300)
  })

  test('explicit call-site override wins over env (settings face)', () => {
    expect(
      resolveConnectionMaxRetries(2, {
        CLAUDE_CODE_MAX_RETRIES: '7',
        CLAUDE_CODE_RETRY_WATCHDOG: '1',
      }),
    ).toBe(2)
  })

  test('CLAUDE_CODE_MAX_RETRIES set → env value honored', () => {
    expect(
      resolveConnectionMaxRetries(undefined, { CLAUDE_CODE_MAX_RETRIES: '7' }),
    ).toBe(7)
  })

  test('budget above fuse eIe=15 without watchdog clamps to 15', () => {
    expect(
      resolveConnectionMaxRetries(undefined, { CLAUDE_CODE_MAX_RETRIES: '50' }),
    ).toBe(15)
  })

  test('explicit face override is exempt from the fuse (lCo: maxRetries ?? cIe)', () => {
    expect(resolveConnectionMaxRetries(20, {})).toBe(20)
    expect(
      resolveConnectionMaxRetries(40, { CLAUDE_CODE_MAX_RETRIES: '2' }),
    ).toBe(40)
  })

  test('budget above fuse with watchdog passes through unclamped', () => {
    expect(
      resolveConnectionMaxRetries(undefined, {
        CLAUDE_CODE_MAX_RETRIES: '50',
        CLAUDE_CODE_RETRY_WATCHDOG: 'true',
      }),
    ).toBe(50)
  })

  test('watchdog env uses raw truthiness: any non-empty string counts (Pq)', () => {
    // Official Pq() returns a.CLAUDE_CODE_RETRY_WATCHDOG verbatim — the
    // string 'false' is truthy, unlike isEnvTruthy parsing.
    expect(
      resolveConnectionMaxRetries(undefined, {
        CLAUDE_CODE_RETRY_WATCHDOG: 'false',
      }),
    ).toBe(300)
    expect(
      resolveConnectionMaxRetries(undefined, {
        CLAUDE_CODE_RETRY_WATCHDOG: '0',
      }),
    ).toBe(300)
    expect(
      resolveConnectionMaxRetries(undefined, {
        CLAUDE_CODE_RETRY_WATCHDOG: '',
      }),
    ).toBe(10)
  })
})

describe('resolveUnavailableOuterRetries (official vWo face)', () => {
  const ENV = 'CLAUDE_CODE_UNAVAILABLE_OUTER_RETRIES'
  const withEnv = (value: string | undefined) => {
    const previous = process.env[ENV]
    if (value === undefined) delete process.env[ENV]
    else process.env[ENV] = value
    return previous
  }
  const restore = (previous: string | undefined) => {
    if (previous === undefined) delete process.env[ENV]
    else process.env[ENV] = previous
  }

  test('env unset → official vZe=0 default (outer layer off)', () => {
    const previous = withEnv(undefined)
    try {
      expect(resolveUnavailableOuterRetries()).toBe(0)
    } finally {
      restore(previous)
    }
  })

  test('a set value is honored', () => {
    const previous = withEnv('3')
    try {
      expect(resolveUnavailableOuterRetries()).toBe(3)
    } finally {
      restore(previous)
    }
  })

  test('>10 falls back to default-off (vWo honors only 0..10, no clamping)', () => {
    const previous = withEnv('20')
    try {
      expect(resolveUnavailableOuterRetries()).toBe(0)
    } finally {
      restore(previous)
    }
  })

  test('garbage or negative values fall back to default-off', () => {
    const previous = withEnv('abc')
    try {
      expect(resolveUnavailableOuterRetries()).toBe(0)
      process.env[ENV] = '-1'
      expect(resolveUnavailableOuterRetries()).toBe(0)
    } finally {
      restore(previous)
    }
  })
})

describe('withConnectionRetry outer retries (unavailableOuterRetries)', () => {
  const ENV = 'CLAUDE_CODE_UNAVAILABLE_OUTER_RETRIES'
  const withEnv = (value: string | undefined) => {
    const previous = process.env[ENV]
    if (value === undefined) delete process.env[ENV]
    else process.env[ENV] = value
    return previous
  }

  test('overload class gets N extra rounds past the exhausted budget', async () => {
    const previous = withEnv('2')
    try {
      let attempts = 0
      const sleeps: number[] = []
      const result = await withConnectionRetry(
        async () => {
          attempts++
          if (attempts < 3) {
            throw Object.assign(new Error('overloaded'), { status: 529 })
          }
          return 'ok'
        },
        { maxRetries: 0, sleep: async ms => void sleeps.push(ms) },
      )
      expect(result).toBe('ok')
      // 1 establishment + 2 outer rounds — the inner budget (0) added none
      expect(attempts).toBe(3)
      // classifier-face curve: min(2000 * 2^(n-1), 10s) + floored
      // additive 0~25% jitter — its own curve, not the inner SDK one
      expect(sleeps[0]).toBeGreaterThanOrEqual(2000)
      expect(sleeps[0]).toBeLessThanOrEqual(2500)
      expect(sleeps[1]).toBeGreaterThanOrEqual(4000)
      expect(sleeps[1]).toBeLessThanOrEqual(5000)
    } finally {
      restoreEnv(ENV, previous)
    }
  })

  test('default off: exhausted budget throws the terminal overload error', async () => {
    const previous = withEnv(undefined)
    try {
      let attempts = 0
      const terminal = Object.assign(new Error('overloaded'), { status: 529 })
      await expect(
        withConnectionRetry(
          async () => {
            attempts++
            throw terminal
          },
          { maxRetries: 1, sleep: async () => {} },
        ),
      ).rejects.toBe(terminal)
      expect(attempts).toBe(2)
    } finally {
      restoreEnv(ENV, previous)
    }
  })

  test('503 is in the official FHt class — outer rounds granted (W2.10 扩类)', async () => {
    const previous = withEnv('1')
    try {
      let attempts = 0
      const terminal = Object.assign(new Error('service unavailable'), {
        status: 503,
      })
      // 官方 FHt（0001:7495）http_5xx 全在类内（W2.10：timeout/connection/
      // http_429/5xx —— 非仅 529+overloaded）：503 拿 1 个外层轮后才让位。
      await expect(
        withConnectionRetry(
          async () => {
            attempts++
            throw terminal
          },
          { maxRetries: 0, sleep: async () => {} },
        ),
      ).rejects.toBe(terminal)
      expect(attempts).toBe(2) // 1 establishment + 1 outer round
    } finally {
      restoreEnv(ENV, previous)
    }
  })

  test('non-FHt class gets no outer rounds (http_4xx stays terminal)', async () => {
    const previous = withEnv('5')
    try {
      let attempts = 0
      // 官方 FHt 只收 timeout/connection/http_429/http_5xx——http_400 不在
      // 类内（`r===429||r>=500&&r<600`），外层不补轮；400 亦非内层可重试
      // 类（408/409/429/5xx 之外）→ 一次即终。
      const terminal = Object.assign(new Error('bad request'), { status: 400 })
      await expect(
        withConnectionRetry(
          async () => {
            attempts++
            throw terminal
          },
          { maxRetries: 1, sleep: async () => {} },
        ),
      ).rejects.toBe(terminal)
      expect(attempts).toBe(1)
    } finally {
      restoreEnv(ENV, previous)
    }
  })
})

describe('withConnectionRetry retry gate（module-006 循环层原文，W2.8）', () => {
  const WATCHDOG = 'CLAUDE_CODE_RETRY_WATCHDOG'

  test('non-429 header wait >60s without the watchdog throws RetryAfterTooLongError', async () => {
    const previous = process.env[WATCHDOG]
    delete process.env[WATCHDOG]
    let attempts = 0
    const sleeps: number[] = []
    // 官方非 429 分支（0001:6798 原文）：`un=XD(...),Pq() ? min(un,oIe) :
    // un>$Eo → throw tengu_api_retry_after_too_long` —— 熔断只作用于
    // 非 429 类且 watchdog 关。
    const failure = Object.assign(new Error('service unavailable'), {
      status: 503,
      headers: { 'retry-after-ms': '90000' },
    })
    try {
      const caught = await withConnectionRetry(
        async () => {
          attempts++
          throw failure
        },
        { maxRetries: 3, sleep: async ms => void sleeps.push(ms) },
      ).catch((e: unknown) => e)
      expect(caught).toBeInstanceOf(RetryAfterTooLongError)
      expect((caught as RetryAfterTooLongError).delayMs).toBe(90000)
      expect((caught as RetryAfterTooLongError).originalError).toBe(failure)
      expect(attempts).toBe(1)
      expect(sleeps).toEqual([])
    } finally {
      restoreEnv(WATCHDOG, previous)
    }
  })

  test('429 has no fuse with the watchdog off — official 恒 min(XD(U,UEo),oIe) loop face', async () => {
    const previous = process.env[WATCHDOG]
    delete process.env[WATCHDOG]
    let attempts = 0
    const sleeps: number[] = []
    // 官方 429 分支原文（0001:6798）：`un = zo ?? Math.min(XD(U, qn, UEo,
    // r.random), oIe)` —— 不读 Pq/$Eo，无熔断；XD 的 r 参只认 retry-after
    // 秒数（iIe 原文），retry-after-ms 属 SDK retryRequest 面（非 429 用）。
    const failure = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after-ms': '90000' },
    })
    try {
      await withConnectionRetry(
        async () => {
          attempts++
          if (attempts === 1) throw failure
          return 'ok'
        },
        { maxRetries: 3, sleep: async ms => void sleeps.push(ms) },
      )
      expect(attempts).toBe(2)
      // XD 循环层曲线（0032:592）：base=min(500·2^0, UEo=300000)=500，
      // +0~25% 上抖动后 round → [500, 625]。
      expect(sleeps[0]).toBeGreaterThanOrEqual(500)
      expect(sleeps[0]).toBeLessThanOrEqual(625)
    } finally {
      restoreEnv(WATCHDOG, previous)
    }
  })

  test('watchdog-on non-429 takes min(un, oIe) instead of fusing（补 cap 未 cap 侧）', async () => {
    const previous = process.env[WATCHDOG]
    process.env[WATCHDOG] = '1'
    let attempts = 0
    const sleeps: number[] = []
    try {
      await withConnectionRetry(
        async () => {
          attempts++
          if (attempts === 1) {
            throw Object.assign(new Error('slow relay'), {
              status: 503,
              headers: { 'retry-after-ms': '90000' },
            })
          }
          return 'ok'
        },
        { maxRetries: 3, sleep: async ms => void sleeps.push(ms) },
      )
      expect(attempts).toBe(2)
      expect(sleeps).toEqual([90000])
    } finally {
      restoreEnv(WATCHDOG, previous)
    }
  })

  test('429 huge retry-after seconds sleep through (XD max-merge, no $Eo fuse)', async () => {
    const previous = process.env[WATCHDOG]
    delete process.env[WATCHDOG]
    let attempts = 0
    const sleeps: number[] = []
    try {
      await withConnectionRetry(
        async () => {
          attempts++
          if (attempts === 1) {
            throw Object.assign(new Error('reset soon'), {
              status: 429,
              headers: { 'retry-after': '1200' },
            })
          }
          return 'ok'
        },
        { maxRetries: 3, sleep: async ms => void sleeps.push(ms) },
      )
      expect(attempts).toBe(2)
      // XD max-merge（0032:592 原文 `return Math.max(c*1000, i)`）：
      // max(1200*1000, jitter[500,625]) = 1200000；min(un, oIe) 不再收敛，
      // 无 $Eo 熔断（watchdog 关也不抛）。
      expect(sleeps).toEqual([1200000])
    } finally {
      restoreEnv(WATCHDOG, previous)
    }
  })
})

describe('withConnectionRetry 401 token-cache refresh retry-once', () => {
  const ENV = 'OPENAI_AUTH_MODE'

  test('401 with the ChatGPT auth face retries exactly once', async () => {
    const previous = process.env[ENV]
    process.env[ENV] = 'chatgpt'
    try {
      let attempts = 0
      const result = await withConnectionRetry(
        async () => {
          attempts++
          if (attempts === 1) {
            throw Object.assign(new Error('unauthorized'), { status: 401 })
          }
          return 'ok'
        },
        // 官方 makeRequest 预算门（0032:706 `if(r&&A)`）：401 刷新重试也
        // 消费预算 —— maxRetries=0 时 remaining==0，401 无「免费一试」
        // （旧实现送的免费尝试已按审查 #3 修正）。
        { maxRetries: 1, sleep: async () => {} },
      )
      expect(result).toBe('ok')
      expect(attempts).toBe(2)
    } finally {
      restoreEnv(ENV, previous)
    }
  })

  test('budget exhausted: 401 gets no free attempt (official `if(r&&A)` gate)', async () => {
    const previous = process.env[ENV]
    process.env[ENV] = 'chatgpt'
    try {
      let attempts = 0
      const result = await withConnectionRetry(
        async () => {
          attempts++
          throw Object.assign(new Error('unauthorized'), { status: 401 })
        },
        { maxRetries: 0, sleep: async () => {} },
      ).catch(e => e)
      expect(attempts).toBe(1)
      expect((result as { status?: number }).status).toBe(401)
    } finally {
      restoreEnv(ENV, previous)
    }
  })

  test('fail-closed 401 rewrap (codex shape) also refreshes once', async () => {
    const previous = process.env[ENV]
    process.env[ENV] = 'chatgpt'
    try {
      let attempts = 0
      await withConnectionRetry(
        async () => {
          attempts++
          if (attempts === 1) {
            throw new Error('ChatGPT Responses API request failed (401)', {
              cause: { status: 401, message: 'unauthorized' },
            })
          }
          return 'ok'
        },
        { maxRetries: 1, sleep: async () => {} },
      )
      expect(attempts).toBe(2)
    } finally {
      restoreEnv(ENV, previous)
    }
  })

  test('a second 401 is terminal (retry-once semantics)', async () => {
    const previous = process.env[ENV]
    process.env[ENV] = 'chatgpt'
    try {
      let attempts = 0
      const result = await withConnectionRetry(
        async () => {
          attempts++
          throw Object.assign(new Error('still unauthorized'), { status: 401 })
        },
        { maxRetries: 3, sleep: async () => {} },
      ).catch(e => e)
      expect(attempts).toBe(2)
      expect((result as { status?: number }).status).toBe(401)
    } finally {
      restoreEnv(ENV, previous)
    }
  })

  test('401 without a refreshable credential face escapes immediately', async () => {
    const previous = process.env[ENV]
    delete process.env[ENV]
    try {
      let attempts = 0
      const result = await withConnectionRetry(
        async () => {
          attempts++
          throw Object.assign(new Error('unauthorized'), { status: 401 })
        },
        { maxRetries: 3, sleep: async () => {} },
      ).catch(e => e)
      expect(attempts).toBe(1)
      expect((result as { status?: number }).status).toBe(401)
    } finally {
      restoreEnv(ENV, previous)
    }
  })

  test('W2.11: per-request usedTokenCache=true grants one refresh + invalidates cache', async () => {
    const previous = process.env[ENV]
    delete process.env[ENV] // 会话级 fallback off —— 只有 per-request 标记放行
    try {
      let attempts = 0
      const invalidations: number[] = []
      const result = await withConnectionRetry(
        async () => {
          attempts++
          // 每次尝试都从 token cache 取凭据（codex getValidChatGPTAuth 面）
          throw Object.assign(new Error('unauthorized'), { status: 401 })
        },
        {
          maxRetries: 3,
          sleep: async () => {},
          usedTokenCache: () => true,
          invalidateTokenCache: () => void invalidations.push(1),
        },
      ).catch(e => e)
      // 第二次 401 仍为终态（官方 didRefreshFor401 单次门）
      expect(attempts).toBe(2)
      expect((result as { status?: number }).status).toBe(401)
      // 官方 `tokenCache.invalidate()` 在重试前执行一次
      expect(invalidations).toHaveLength(1)
    } finally {
      restoreEnv(ENV, previous)
    }
  })

  test('W2.11: per-request usedTokenCache=false does not grant the 401 retry', async () => {
    const previous = process.env[ENV]
    process.env[ENV] = 'chatgpt' // 会话级放宽开着 —— per-request 标记优先
    try {
      let attempts = 0
      const result = await withConnectionRetry(
        async () => {
          attempts++
          throw Object.assign(new Error('unauthorized'), { status: 401 })
        },
        {
          maxRetries: 3,
          sleep: async () => {},
          // 非缓存请求面（API-key 路径）：官方 `n.usedTokenCache` 为 false
          // → 401 门不放行（不含会话级 fallback）。
          usedTokenCache: () => false,
        },
      ).catch(e => e)
      expect(attempts).toBe(1)
      expect((result as { status?: number }).status).toBe(401)
    } finally {
      restoreEnv(ENV, previous)
    }
  })
})

describe('withConnectionRetry 401 gate order (审查 #3: 401 先于 veto 且耗预算)', () => {
  test('401 + x-should-retry:true consumes the refresh gate, never the generic budget first', async () => {
    // 官方 shouldRetry 原文（0032:706）：401 分支在 x-should-retry 读取之前
    // —— 旧 token 的 401 第一跳就走刷新面（invalidate + 单次重试），不以
    // 通用可重试身份烧第一格预算。
    let attempts = 0
    const invalidations: number[] = []
    const result = await withConnectionRetry(
      async () => {
        attempts++
        if (attempts === 1) {
          throw Object.assign(new Error('unauthorized (veto says retry)'), {
            status: 401,
            headers: { 'x-should-retry': 'true' },
          })
        }
        return 'ok'
      },
      {
        maxRetries: 1,
        sleep: async () => {},
        usedTokenCache: () => true,
        invalidateTokenCache: () => void invalidations.push(1),
      },
    )
    expect(result).toBe('ok')
    // 新序：refresh-retry 消费 401 门（maxRetries=1 的唯一一格预算）；
    // attempt 2 成功。旧序：第一格走通用面（without invalidate），401 门
    // 只在 remaining==0 的免费面上生效——invalidation 时点完全不同。
    expect(attempts).toBe(2)
    expect(invalidations).toHaveLength(1)
  })

  test('spent-refresh 401 without a veto header is terminal (official shouldRetry tail)', async () => {
    // 官方 shouldRetry 原文（0032:706）：didRefreshFor401 置位后 401 语句
    // 不再命中，落到 veto/状态尾——`let s=e.headers.get("x-should-retry");
    // if(s==="true")return!0;if(s==="false")return!1;if(e.status===408)…`
    // 无头且 401 ∉ {408,409,429,5xx} → 返回 false，不再重试。
    let attempts = 0
    const result = await withConnectionRetry(
      async () => {
        attempts++
        throw Object.assign(new Error('still unauthorized'), { status: 401 })
      },
      { maxRetries: 3, sleep: async () => {}, usedTokenCache: () => true },
    ).catch(e => e)
    // attempt1 走 401 刷新门；attempt2 落 shouldRetry 尾 false → 终态。
    expect(attempts).toBe(2)
    expect((result as { status?: number }).status).toBe(401)
  })

  test('spent-refresh 401 with a live veto retries through the generic face (official `if(s==="true")return!0`)', async () => {
    // 官方原文：401 分支让位后（didRefreshFor401 已置位），第二个 401 的
    // x-should-retry:true 仍**返回 true**——通用面在预算内继续重试
    // （makeRequest `if(r&&A)`），预算烧尽才终态。previous 断言「不复活
    // 通用面」是反官方的（把 veto 语义改成了 401 拦截）。
    let attempts = 0
    const result = await withConnectionRetry(
      async () => {
        attempts++
        throw Object.assign(new Error('still unauthorized'), {
          status: 401,
          headers: { 'x-should-retry': 'true' },
        })
      },
      { maxRetries: 3, sleep: async () => {}, usedTokenCache: () => true },
    ).catch(e => e)
    // attempt1 = 401 刷新门（预算扣 1）；attempt2-4 = veto 面重试（预算
    // 扣 3-1=2 格 + 终态）→ 共 4 次尝试。
    expect(attempts).toBe(4)
    expect((result as { status?: number }).status).toBe(401)
  })
})

describe('retry-after-ms 0/负值语义（审查 #6.1: 官方视 0 为缺省，负值不 clamp）', () => {
  test('retry-after-ms "0" falls through to the retry-after seconds header (`if(c&&!o)`)', async () => {
    const sleeps: number[] = []
    let attempts = 0
    await withConnectionRetry(
      async () => {
        attempts++
        if (attempts === 1) {
          throw Object.assign(new Error('throttled'), {
            status: 503,
            headers: { 'retry-after-ms': '0', 'retry-after': '3' },
          })
        }
        return 'ok'
      },
      { maxRetries: 2, sleep: async ms => void sleeps.push(ms) },
    )
    // 官方 retryRequest：`o=0` 后 `if(c&&!o)` 让秒数头补位 —— 3000，非 0。
    expect(sleeps).toEqual([3000])
  })

  test('retry-after-ms "0" alone stays 0 (no curve fallback — `o===void 0` never fires)', async () => {
    const sleeps: number[] = []
    let attempts = 0
    await withConnectionRetry(
      async () => {
        attempts++
        if (attempts === 1) {
          throw Object.assign(new Error('throttled'), {
            status: 503,
            headers: { 'retry-after-ms': '0' },
          })
        }
        return 'ok'
      },
      { maxRetries: 2, sleep: async ms => void sleeps.push(ms) },
    )
    // fe(0) 即时不等待 —— 决不能落回 500ms×(1-jitter) 计算曲线。
    expect(sleeps).toEqual([0])
  })

  test('negative retry-after-ms passes through unclamped (fe(negative) = no sleep)', async () => {
    const sleeps: number[] = []
    let attempts = 0
    await withConnectionRetry(
      async () => {
        attempts++
        if (attempts === 1) {
          throw Object.assign(new Error('throttled'), {
            status: 503,
            headers: { 'retry-after-ms': '-250' },
          })
        }
        return 'ok'
      },
      { maxRetries: 2, sleep: async ms => void sleeps.push(ms) },
    )
    // 官方负值不 clamp：fe(-250) 经 setTimeout 语义为直通；clamp 成 0 或
    // 反弹回曲线都是偏差面。
    expect(sleeps).toEqual([-250])
  })
})

describe('outer rounds use an independent counter (审查 #6.2: attempt-maxRetries 漂移)', () => {
  test('a 401-gate retry does not consume an outer round (independent Er counter)', async () => {
    const ENV = 'CLAUDE_CODE_UNAVAILABLE_OUTER_RETRIES'
    const previous = process.env[ENV]
    process.env[ENV] = '1'
    const authPrevious = process.env.OPENAI_AUTH_MODE
    delete process.env.OPENAI_AUTH_MODE
    try {
      let attempts = 0
      const sleeps: number[] = []
      const result = await withConnectionRetry(
        async () => {
          attempts++
          if (attempts === 1) {
            // 401 刷新门：这时 maxRetries=1 的内层预算还在（remaining=1），
            // 门内消费一格（官方 makeRequest `if(r&&A)` 统一预算门）。
            throw Object.assign(new Error('unauthorized'), { status: 401 })
          }
          if (attempts === 2) {
            // 内层预算已尽（remaining==0 → maxRetries-attempt+1 = 0），落
            // 外层面。旧实现 outerRound = attempt - maxRetries = 1；401 门
            // 借走 attempt 的组合（免费面时代，attempt 超出 maxRetries+1）
            // 会把第一个外层轮算成第 2 轮 → 少拿轮。新实现以独立计数器
            // 推进（官方 :7495 `for(Er=1;Er<=zo;Er++)` 的 Er 面）：round 1
            // 恒从 TZe=2000 起步。
            throw Object.assign(new Error('overloaded'), { status: 529 })
          }
          return 'ok'
        },
        {
          // 401 门必须拿到预算（remaining>0，免费一试已按审查 #3 移除）。
          maxRetries: 1,
          sleep: async ms => void sleeps.push(ms),
          usedTokenCache: () => true,
        },
      )
      expect(result).toBe('ok')
      // 1 establishment + 1 401-refresh retry + 1 outer round
      expect(attempts).toBe(3)
      // sleeps[0] = 401 门重试的 SDK 曲线（min(0.5·2^0, 8s)·(1-rand·0.25)
      // → [375, 500]）；sleeps[1] 才是外层轮 classifier 曲线。
      expect(sleeps).toHaveLength(2)
      // round 1 = min(2000·2^0, 10s) + 0~25% floored jitter → [2000, 2500]
      expect(sleeps[1]).toBeGreaterThanOrEqual(2000)
      expect(sleeps[1]).toBeLessThanOrEqual(2500)
    } finally {
      restoreEnv(ENV, previous)
      restoreEnv('OPENAI_AUTH_MODE', authPrevious)
    }
  })
})
