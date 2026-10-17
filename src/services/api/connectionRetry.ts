import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from 'src/utils/errors.js'

/**
 * Connection-layer retry for the non-Anthropic provider adapters
 * (openai-compatible, grok, codex, gemini) — ported from the official
 * Anthropic SDK request loop (reverse-284 decompiled
 * 0032-chunk-dyqmyxqn: makeRequest / shouldRetry / retryRequest):
 *
 * 1. Connection-class failures (timeout / refused / reset / half-open /
 *    invalid relay response) never surface while attempts remain — the SDK
 *    logs `connection timed out/failed - retrying, N attempts remaining`
 *    and re-arms. Only a spent budget lets the terminal error escape.
 * 2. Callers must wrap only the establishment phase (request → response
 *    headers / stream object). Streaming bodies are guarded by the silence
 *    watchdog and are never retried here — a mid-stream retry would
 *    double-execute tools (inc-4258).
 * 3. Server veto: `x-should-retry: false` suppresses retry (5xx in ant
 *    builds excepted, mirroring withRetry.shouldRetry); `x-should-retry:
 *    true` and 408/409/429/5xx allow it.
 * 4. Backoff: min(0.5 * 2^(attempt-1), 8s) * jitter(0.75–1.0), honoring
 *    retry-after-ms / retry-after headers (seconds or HTTP-date).
 * 5. The terminal error rethrown after an exhausted budget keeps its
 *    original class — the caller's formatting surface is unchanged.
 */

const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
])

const RETRYABLE_STATUS = new Set([408, 409, 429])

function errStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/**
 * Some adapter layers fail-closed re-wrap establishment errors into plain
 * Errors (e.g. "ChatGPT Responses API request failed (429)") hiding the
 * wire-classification fields from the surface. The original rides along in
 * the `cause` chain — these accessors traverse it (bounded) so a re-wrap
 * never strips retry classification.
 */
function* causeChain(error: unknown): Generator<unknown> {
  let current: unknown = error
  for (let hop = 0; hop < 3; hop++) {
    // Skip non-object hops (undefined cause etc.) — yielding them would
    // append "undefined" to errMessageWithCause and break anchored matches.
    if (typeof current !== 'object' || current === null) return
    yield current
    current = (current as { cause?: unknown }).cause
  }
}

function firstCauseOf<T>(error: unknown, read: (e: unknown) => T): T {
  for (const node of causeChain(error)) {
    const value = read(node)
    if (value !== undefined) return value
  }
  return undefined as T
}

function errStatusOf(error: unknown): number | undefined {
  return firstCauseOf(error, errStatus)
}

function errCodeOf(error: unknown): string | undefined {
  return firstCauseOf(error, errCode)
}

function errHeaderOf(error: unknown, name: string): string | undefined {
  return firstCauseOf(error, e => errHeader(e, name))
}

function errMessageWithCause(error: unknown): string {
  let text = ''
  for (const node of causeChain(error)) text += ` ${errorMessage(node)}`
  return text
}

function errCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Runtime class identity for SDK error subclasses that never set the
 * `name` property (openai 7.x APIUserAbortError ships with
 * `name === 'Error'` but constructor.name intact).
 */
function errClassName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const ctor = (error as { constructor?: unknown }).constructor
  if (typeof ctor === 'function') {
    const ctorName = (ctor as { name?: unknown }).name
    if (typeof ctorName === 'string' && ctorName !== 'Error') return ctorName
  }
  return undefined
}

function errClassNameOf(error: unknown): string | undefined {
  return firstCauseOf(error, errClassName)
}

function errHeader(error: unknown, name: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const headers = (error as { headers?: unknown }).headers
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (typeof headers === 'object' && headers !== null) {
    const value = (headers as Record<string, unknown>)[name]
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

function isTimeoutClassError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  if (name === 'TimeoutError' || name === 'AbortError') return true
  return /timed? ?out/i.test(errMessageWithCause(error))
}

function isConnectionClassError(error: unknown): boolean {
  const code = errCodeOf(error)
  if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) return true
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name
    if (
      name === 'TypeError' &&
      /fetch failed/i.test(errMessageWithCause(error))
    ) {
      // undici/Bun aggregate for refused/DNS/reset transport failures
      return true
    }
    if (/InvalidHTTPResponse/i.test(errMessageWithCause(error))) {
      // Bun fetch: the relay closed/damaged the HTTP framing
      return true
    }
    if (name === 'ConnectionError' || name === 'AbortError') return true
    // OpenAI SDK aborts the request when the per-attempt watchdog fires
    // during establishment (stalled headers). Two shapes reach us (user
    // aborts are already filtered by the signal check above — an
    // APIUserAbort here is always a watchdog establishment stall):
    // - openai SDK 7.x: OpenAIError subclass but with runtime
    //   `constructor.name === 'APIUserAbortError'` (the `name` property is
    //   never set — matching instance name is dead code)
    // - genai SDK: ApiError with message 'Request was aborted.'
    // Both are timeout-class failures the retry layer re-arms with a fresh
    // watchdog.
    if (errClassNameOf(error) === 'APIUserAbortError') return true
    // genai surfaces its establishment abort as a bare Error whose ENTIRE
    // message is exactly this phrase — anchored match, not a substring scan
    // (a relay 400 body merely CONTAINING the phrase is a status-coded
    // refusal, not a transport abort, and must keep its no-retry semantics).
    if (/^\s*request was aborted\.?\s*$/i.test(errMessageWithCause(error))) {
      return true
    }
  }
  return isTimeoutClassError(error)
}

export function isProviderConnectionRetryable(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  // A user-initiated abort is never retried; an AbortError from anything
  // else (per-attempt watchdog, relay teardown) is a timeout-class failure.
  if (signal?.aborted) return false

  // Same veto order as withRetry.shouldRetry: the server explicitly says
  // whether to retry. Ant builds may ignore a false for 5xx server errors.
  const veto = errHeaderOf(error, 'x-should-retry')
  if (veto === 'false') {
    const status = errStatusOf(error) ?? 0
    const is5xxError = status >= 500
    if (!(process.env.USER_TYPE === 'ant' && is5xxError)) return false
  }
  if (veto === 'true') return true
  if (isConnectionClassError(error)) return true

  const status = errStatusOf(error)
  if (status === undefined) return false
  return RETRYABLE_STATUS.has(status) || status >= 500
}

function retryAfterMs(error: unknown): number | undefined {
  const asMs = errHeaderOf(error, 'retry-after-ms')
  if (asMs !== undefined) {
    const parsed = Number.parseFloat(asMs)
    if (!Number.isNaN(parsed)) return parsed
  }
  const asSeconds = errHeaderOf(error, 'retry-after')
  if (asSeconds === undefined) return undefined
  const seconds = Number.parseFloat(asSeconds)
  if (!Number.isNaN(seconds)) return seconds * 1000
  const asDate = Date.parse(asSeconds)
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now())
  return undefined
}

function computeBackoffDelayMs(error: unknown, attempt: number): number {
  const fromHeader = retryAfterMs(error)
  if (fromHeader !== undefined) return Math.min(fromHeader, 30_000)
  const base = Math.min(0.5 * 2 ** (attempt - 1), 8)
  const jitter = 1 - Math.random() * 0.25
  return base * jitter * 1000
}

// unref'd: a long retry-after cap (30s) must not pin the event loop alive
// after every other handle is gone (e.g. abort threw past the sleep).
const defaultSleep = (ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<void>(resolve => {
    timer = setTimeout(resolve, ms)
  })
  const unref = (timer as unknown as { unref?: () => void } | undefined)?.unref
  if (unref) unref.call(timer)
  return promise
}

export interface ConnectionRetryOptions {
  /** Official SDK default; CLAUDE_CODE_CONNECTION_MAX_RETRIES overrides. */
  maxRetries?: number
  /** The session-level signal — aborted here marks a user abort (no retry). */
  signal?: AbortSignal
  /** Debug-log prefix (query source), mirroring `connection ${kind} - retrying`. */
  source?: string
  /** Test injection point for the backoff sleep. */
  sleep?: (ms: number) => Promise<void>
}

export async function withConnectionRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: ConnectionRetryOptions = {},
): Promise<T> {
  const envMax = Number.parseInt(
    process.env.CLAUDE_CODE_CONNECTION_MAX_RETRIES ?? '',
    10,
  )
  const maxRetries =
    options.maxRetries ?? (Number.isFinite(envMax) ? envMax : 2)
  const sleep = options.sleep ?? defaultSleep
  let attempt = 0
  while (true) {
    attempt++
    try {
      return await operation(attempt)
    } catch (error) {
      const remaining = maxRetries - attempt + 1
      if (
        remaining <= 0 ||
        !isProviderConnectionRetryable(error, options.signal)
      ) {
        throw error
      }
      const timedOut = isTimeoutClassError(error)
      logForDebugging(
        `connection ${timedOut ? 'timed out' : 'failed'} - retrying, ${remaining} attempts remaining${options.source ? ` (${options.source})` : ''}`,
      )
      // Backoff races the abort signal: a user abort during the sleep must
      // not spawn one extra doomed attempt. The listener is removed on the
      // sleep-win path too (the session signal outlives this loop).
      let removeAbortListener = () => {}
      const abortPromise = options.signal
        ? new Promise<'abort'>(resolve => {
            if (options.signal!.aborted) {
              resolve('abort')
              return
            }
            const onAbort = () => resolve('abort')
            options.signal!.addEventListener('abort', onAbort, { once: true })
            removeAbortListener = () =>
              options.signal!.removeEventListener('abort', onAbort)
          })
        : undefined
      const winner = await Promise.race([
        sleep(computeBackoffDelayMs(error, attempt)).then(() => 'sleep'),
        ...(abortPromise ? [abortPromise] : []),
      ])
      removeAbortListener()
      if (winner === 'abort') throw error
    }
  }
}
