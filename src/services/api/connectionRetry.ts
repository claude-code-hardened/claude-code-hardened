import { randomUUID } from 'crypto'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from 'src/utils/errors.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { isChatGPTAuthEnabled } from './openai/chatgptAuth.js'

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
 * 4. Backoff (0032 SDK 原文 makeRequest/retryRequest, module-005):
 *    retry-after-ms / retry-after headers FULLY override the curve
 *    (`if (o === void 0)` guards the computed default — never a
 *    max(header, base) merge). Without a header:
 *    min(0.5 * 2^(attempt-1), 8s) * (1 - rand*0.25) — an UNROUNDED
 *    downward jitter, capped at 8s at the SDK layer.
 * 5. Retry-after-too-long fuse (module-006 loop): a resolved delay above
 *    $Eo=60000 with the retry watchdog off throws RetryAfterTooLongError
 *    instead of sleeping (official `tengu_api_retry_after_too_long`).
 * 6. The terminal error rethrown after an exhausted budget keeps its
 *    original class — the caller's formatting surface is unchanged.
 * 7. Outer-retry face (module-006 vWo() + classifier TZe/EZe curve): after
 *    the inner budget is spent, the 529/overloaded_error class (official
 *    rP) may get N extra rounds behind
 *    CLAUDE_CODE_UNAVAILABLE_OUTER_RETRIES (default off, 0..10 on the vWo
 *    face — out-of-bounds falls back to 0), backed by its own
 *    min(2000 * 2^(n-1), 10s) + floor additive-jitter curve, separate from
 *    the inner SDK curve.
 * 8. A 401 while a refreshable token face exists (ChatGPT OAuth) retries
 *    exactly once so the next getValidChatGPTAuth() can rotate the cached
 *    credential.
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
  // 0032 SDK 原文 retryRequest (module-005): a parseable retry-after-ms /
  // retry-after header FULLY overrides the computed curve — `if (o ===
  // void 0)` guards the calculation, never a max(header, base) merge.
  const fromHeader = retryAfterMs(error)
  if (fromHeader !== undefined) {
    return fromHeader
  }
  // calculateDefaultRetryTimeoutMillis(remaining, maxRetries): the exponent
  // is (maxRetries - remaining) — on this 1-based loop that is attempt - 1
  // (first retry 0.5s). SDK-layer cap is 8s; jitter multiplies DOWN by
  // (1 - rand*0.25), unrounded.
  const baseMs = Math.min(0.5 * 2 ** (attempt - 1), 8) * 1000
  return baseMs * (1 - Math.random() * 0.25)
}

/**
 * Retry-after-too-long fuse (module-006 retry loop): with the retry
 * watchdog off, a resolved delay above $Eo=60000 aborts the session loop
 * (`tengu_api_retry_after_too_long` + a session-drop error) instead of
 * sleeping — runaway server-specified waits must surface, not stall.
 */
export class RetryAfterTooLongError extends Error {
  constructor(
    public readonly delayMs: number,
    public readonly originalError: unknown,
  ) {
    super(
      `Retry-after ${Math.round(delayMs / 100) / 10}s exceeds the 60s fuse — ` +
        'set CLAUDE_CODE_RETRY_WATCHDOG to allow long server-specified waits.',
    )
    this.name = 'RetryAfterTooLongError'
  }
}

// module-006 $Eo: the official too-long threshold.
const RETRY_AFTER_TOO_LONG_MS = 60_000

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

export interface ConnectionRetryStatus {
  /** The attempt number that just failed (1-based). */
  attempt: number
  /** The resolved inner retry budget (不含外层轮次). */
  maxRetries: number
  /** Backoff before the next attempt, in milliseconds. */
  retryInMs: number
  /** Official onRetryStatus kind tag (module-006 emits `retrying`). */
  kind: 'retrying'
  /** The failed establishment error that triggered this retry. */
  error: unknown
  /** Official countdown deadline (Date.now() + retryInMs). */
  deadline: number
}

/**
 * Official g0 face (module-006): a retry status as a system/api_error
 * message row — the message stream renders it as "Retrying in Xs…
 * (attempt n/N)". Adapter generators cannot yield mid-await, so they buffer
 * these during establishment and replay them right after the stream is
 * secured.
 */
export function retryStatusMessage(
  status: ConnectionRetryStatus,
): SystemAPIErrorMessage {
  return {
    type: 'system',
    subtype: 'api_error',
    level: 'error',
    error: status.error,
    retryInMs: status.retryInMs,
    retryAttempt: status.attempt,
    maxRetries: status.maxRetries,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}

export interface ConnectionRetryOptions {
  /** Explicit budget override (call-site). Otherwise the env chain below. */
  maxRetries?: number
  /** The session-level signal — aborted here marks a user abort (no retry). */
  signal?: AbortSignal
  /** Debug-log prefix (query source), mirroring `connection ${kind} - retrying`. */
  source?: string
  /** Test injection point for the backoff sleep. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Optional per-retry status callback — official module-006 payload
   * ({kind:'retrying', error, attempt, maxRetries, retryInMs, deadline}).
   * Establishment retry happens before any stream exists, so generator call
   * sites cannot yield a SystemAPIErrorMessage mid-await; adapter call sites
   * buffer these notices and replay them as system/api_error message rows
   * right after establishment (official g0 face: "Retrying in Xs · attempt
   * n/N"), keeping the debug-channel log.
   */
  onRetryStatus?: (status: ConnectionRetryStatus) => void
}

/**
 * Official retry budget chain (reverse-284 module-006 `cIe()`:
 * constants wZe=4 / eIe=15 / EEo=10 / REo=300; face `lCo(e) = e.maxRetries
 * ?? cIe()`):
 *   explicit call-site override (lCo's settings face — used AS-IS: the eIe
 *   fuse lives inside cIe and never touches a face value)
 *   > CLAUDE_CODE_MAX_RETRIES (official env name)
 *   > CLAUDE_CODE_CONNECTION_MAX_RETRIES (CCH legacy alias, still honored)
 *   > two-layer default floor: EEo=10 with the retry watchdog off, REo=300
 *     with it on (`cIe()` tail: `return e ? REo : EEo`).
 * An env-tier budget above eIe=15 requires CLAUDE_CODE_RETRY_WATCHDOG (the
 * official fuse: runaway budgets hang the session in retry loops) —
 * otherwise it is clamped to 15 with a one-time warn-level notice
 * (`max_retries_clamp_warning`).
 */
const OFFICIAL_RETRY_FUSE = 15 // eIe
const OFFICIAL_DEFAULT_RETRIES = 10 // EEo — env-unset floor
const OFFICIAL_WATCHDOG_DEFAULT_RETRIES = 300 // REo — env-unset + watchdog

/** Official outer-retry backoff curve (module-006 classifier face). */
const OUTER_RETRY_BASE_MS = 2000 // TZe
const OUTER_RETRY_CAP_MS = 10_000 // EZe

/**
 * Official outer-retry face (reverse-284 module-006 `vWo()`, constant
 * vZe=0): `unavailableOuterRetries` grants N extra rounds past the inner
 * budget for the unavailable/overloaded error class only. Officially a
 * growthbook integer — only 0..10 is honored; any out-of-bounds value falls
 * back to vZe=0 (no clamping to the cap). CCH surfaces it as the
 * CLAUDE_CODE_UNAVAILABLE_OUTER_RETRIES env with the same semantics.
 */
const UNAVAILABLE_OUTER_RETRIES_ENV = 'CLAUDE_CODE_UNAVAILABLE_OUTER_RETRIES'
const OFFICIAL_OUTER_RETRY_CAP = 10 // vWo upper bound (values above fall back)

/**
 * Official watchdog read (module-006 `Pq()`:
 * `return a.CLAUDE_CODE_RETRY_WATCHDOG`): the raw env value's own truthiness
 * — any set non-empty string counts as on ('false' and '0' included); only
 * unset or '' reads off.
 */
function isRetryWatchdogOn(env: Record<string, string | undefined>): boolean {
  const watchdog = env.CLAUDE_CODE_RETRY_WATCHDOG
  return watchdog !== undefined && watchdog !== ''
}

export function resolveConnectionMaxRetries(
  override?: number,
  env: Record<string, string | undefined> = process.env,
): number {
  // lCo(e) = e.maxRetries ?? cIe(): the face value owns its budget with no
  // fuse — the eIe clamp below applies to the env tiers only.
  if (override !== undefined) return override
  const parse = (raw: string | undefined): number | undefined => {
    const parsed = Number.parseInt(raw ?? '', 10)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
  }
  const explicit =
    parse(env.CLAUDE_CODE_MAX_RETRIES) ??
    parse(env.CLAUDE_CODE_CONNECTION_MAX_RETRIES)
  if (explicit === undefined) {
    // cIe() tail: no env → EEo=10, or REo=300 when the retry watchdog is on
    // (watchdog sessions accept the long budget).
    return isRetryWatchdogOn(env)
      ? OFFICIAL_WATCHDOG_DEFAULT_RETRIES
      : OFFICIAL_DEFAULT_RETRIES
  }
  if (explicit > OFFICIAL_RETRY_FUSE && !isRetryWatchdogOn(env)) {
    logClampWarningOnce(explicit)
    return OFFICIAL_RETRY_FUSE
  }
  return explicit
}

// Official `Ui().once("max_retries_clamp_warning")`: one warn-level notice
// per process, not per call.
let clampWarningEmitted = false
function logClampWarningOnce(explicit: number): void {
  if (clampWarningEmitted) return
  clampWarningEmitted = true
  logForDebugging(
    `CLAUDE_CODE_MAX_RETRIES=${explicit} clamped to ${OFFICIAL_RETRY_FUSE}`,
    { level: 'warn' },
  )
}

export function resolveUnavailableOuterRetries(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number.parseInt(env[UNAVAILABLE_OUTER_RETRIES_ENV] ?? '', 10)
  // vWo(): only an integer inside 0..10 is honored — anything else (garbage,
  // negative, >10) falls back to the vZe=0 default instead of clamping.
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > OFFICIAL_OUTER_RETRY_CAP
  ) {
    return 0 // vZe — outer layer default-off
  }
  return parsed
}

/**
 * Unavailable/overloaded class for the outer-retry face — official rP
 * (module-006) verbatim: 529, or the streaming-shape overload where the
 * relay reports `"type":"overloaded_error"` in the message instead of a
 * status. 503 is NOT part of rP (it stays a plain 5xx for the inner layer).
 */
function isUnavailableOverloadedError(error: unknown): boolean {
  return (
    errStatusOf(error) === 529 ||
    errMessageWithCause(error).includes('"type":"overloaded_error"')
  )
}

/** Outer-round backoff: TZe=2000·2^(n-1) capped at EZe=10s + floored
 * additive 0~+25% jitter (module-006 classifier face, not the SDK curve). */
function computeOuterBackoffDelayMs(round: number): number {
  const baseMs = Math.min(
    OUTER_RETRY_BASE_MS * 2 ** (round - 1),
    OUTER_RETRY_CAP_MS,
  )
  return baseMs + Math.floor(Math.random() * baseMs * 0.25)
}

export async function withConnectionRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: ConnectionRetryOptions = {},
): Promise<T> {
  const maxRetries = resolveConnectionMaxRetries(options.maxRetries)
  const outerRetries = resolveUnavailableOuterRetries()
  const sleep = options.sleep ?? defaultSleep
  // Backoff races the abort signal: a user abort during the sleep must
  // not spawn one extra doomed attempt. The listener is removed on the
  // sleep-win path too (the session signal outlives this loop). Returns
  // false when the abort won the race (caller rethrows).
  const sleepBeforeRetry = async (ms: number): Promise<boolean> => {
    if (!options.signal) {
      await sleep(ms)
      return true
    }
    let removeAbortListener = () => {}
    const abortPromise = new Promise<'abort'>(resolve => {
      if (options.signal!.aborted) {
        resolve('abort')
        return
      }
      const onAbort = () => resolve('abort')
      options.signal!.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () =>
        options.signal!.removeEventListener('abort', onAbort)
    })
    const winner = await Promise.race([
      sleep(ms).then(() => 'sleep'),
      abortPromise,
    ])
    removeAbortListener()
    return winner === 'sleep'
  }
  let attempt = 0
  let authRefreshRetrySpent = false
  // Retry-after-too-long gate (module-006: `un > $Eo && !Pq()` → throw):
  // without the retry watchdog, a resolved wait above 60s surfaces as a
  // RetryAfterTooLongError instead of stalling the session. Watchdog-on
  // sessions take the official `min(un, oIe)` path instead (unbounded wait
  // accepted).
  const gateDelayMs = (ms: number, failure: unknown): number => {
    if (ms > RETRY_AFTER_TOO_LONG_MS && !isRetryWatchdogOn(process.env)) {
      throw new RetryAfterTooLongError(ms, failure)
    }
    return ms
  }
  const retryStatus = (
    attemptNumber: number,
    retryInMs: number,
    failure: unknown,
  ): ConnectionRetryStatus => ({
    attempt: attemptNumber,
    maxRetries,
    retryInMs,
    kind: 'retrying',
    error: failure,
    deadline: Date.now() + retryInMs,
  })
  while (true) {
    attempt++
    try {
      return await operation(attempt)
    } catch (error) {
      const remaining = maxRetries - attempt + 1
      if (
        remaining > 0 &&
        isProviderConnectionRetryable(error, options.signal)
      ) {
        const timedOut = isTimeoutClassError(error)
        const retryInMs = gateDelayMs(
          computeBackoffDelayMs(error, attempt),
          error,
        )
        logForDebugging(
          `connection ${timedOut ? 'timed out' : 'failed'} - retrying, ${remaining} attempts remaining${options.source ? ` (${options.source})` : ''}`,
        )
        options.onRetryStatus?.(retryStatus(attempt, retryInMs, error))
        if (!(await sleepBeforeRetry(retryInMs))) throw error
        continue
      }
      // 401 with a refreshable credential face (ChatGPT OAuth): the cached
      // access token may have expired server-side — the next getValidChatGPTAuth()
      // re-reads the auth file and refreshes near-expiry tokens. Exactly one
      // such retry is granted; a second 401 is a real auth failure.
      if (
        errStatusOf(error) === 401 &&
        !authRefreshRetrySpent &&
        !options.signal?.aborted &&
        isChatGPTAuthEnabled()
      ) {
        authRefreshRetrySpent = true
        const retryInMs = gateDelayMs(
          computeBackoffDelayMs(error, attempt),
          error,
        )
        logForDebugging(
          `connection 401 - refreshing token cache, retrying once${options.source ? ` (${options.source})` : ''}`,
        )
        options.onRetryStatus?.(retryStatus(attempt, retryInMs, error))
        if (!(await sleepBeforeRetry(retryInMs))) throw error
        continue
      }
      if (remaining > 0) throw error
      // Official outer-retry face (module-006 vWo() unavailableOuterRetries):
      // past the exhausted inner budget, the rP overload class (529 +
      // overloaded_error body) gets N more rounds (default vZe=0 — off).
      // Each round backoffs on the classifier-face curve — its own
      // min(TZe·2^(n-1), EZe) + floored additive jitter, separate from the
      // inner SDK curve.
      const outerRound = attempt - maxRetries
      if (
        outerRound > outerRetries ||
        options.signal?.aborted ||
        !isUnavailableOverloadedError(error) ||
        !isProviderConnectionRetryable(error, options.signal)
      ) {
        throw error
      }
      const retryInMs = computeOuterBackoffDelayMs(outerRound)
      logForDebugging(
        `connection unavailable (overloaded) - outer retry ${outerRound}/${outerRetries}${options.source ? ` (${options.source})` : ''}`,
      )
      options.onRetryStatus?.(retryStatus(attempt, retryInMs, error))
      if (!(await sleepBeforeRetry(retryInMs))) throw error
    }
  }
}
