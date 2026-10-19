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
 *    W2.9 两套共存面：429 的循环层延迟另走 XD 曲线（0032:592 原文，
 *    retry-after max(c*1000, i) 合并 + UEo=300000 base cap + 上抖动
 *    round），其余建立面维持本 retryRequest 版。
 * 5. Retry gate（module-006 循环层原文，W2.8 收敛）：429 分支恒
 *    Math.min(XD(UEo), oIe=21600000)——原文 429 不读 Pq/$Eo，无熔断；
 *    非 429：watchdog on（CLAUDE_CODE_RETRY_WATCHDOG）→ min(un, oIe)
 *    （补官方 cap 的未 cap 侧），watchdog off → un>$Eo=60000 抛
 *    RetryAfterTooLongError（官方 `tengu_api_retry_after_too_long`）。
 * 6. The terminal error rethrown after an exhausted budget keeps its
 *    original class — the caller's formatting surface is unchanged.
 * 7. Outer-retry face (module-006 vWo() + :7495 循环原文 + classifier
 *    TZe/EZe curve): after the inner budget is spent, N extra rounds
 *    (default off, 0..10 on the vWo face — out-of-bounds falls back to 0)
 *    run while the error stays in the official FHt class (W2.10：
 *    wall_clock/connection timeout + connection_error + http_429/5xx —
 *    非仅 529+overloaded；529/overloaded_error 体面保留)，且官方
 *    「有 retryAfterMs 即 break」（`Fo.retryAfterMs!==void 0 → break`，
 *    服务端已给等待时长不再外层补轮）。每轮用
 *    min(2000 * 2^(n-1), 10s) + floor additive-jitter curve, separate from
 *    the inner SDK curve.
 * 8. A 401 refresh gate follows the official per-request semantics
 *    (W2.11, 0032:706 shouldRetry 原文): only a request that actually
 *    served its credential from the token cache (usedTokenCache 标记) and
 *    has not refreshed yet retries once, invalidating the cache
 *    (`tokenCache.invalidate()`) first. 调用点缺省无标记时保留会话级
 *    isChatGPTAuthEnabled() 放宽作 fallback（取舍声明见 options 注释）。
 * 9. onRetryStatus buffering: establishment-terminal throws and aborts
 *    flush the buffered "Retrying in Xs…" rows before the error escapes
 *    (adapter call sites' catch; W2.12 — official g0 face rows otherwise
 *    lost in the discard window).
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

// module-006 循环层 oIe：watchdog-on 面 / 429 延迟面的上限（6h）。
const OIe_LOOP_DELAY_CAP_MS = 21_600_000
// module-006 循环层 UEo：429 分支 XD 曲线的 base cap（5min）。
const Ueo_429_LOOP_CAP_MS = 300_000

/**
 * 循环层 XD 曲线（W2.9，官方 0032-chunk-dyqmyxqn/module-005-uncategorized.js
 * :592 原文：`function XD(e,r,n=32000,s=Math.random){let o=Math.min(500*
 * Math.pow(2,e-1),n),i=Math.round(o+s()*0.25*o);if(r){let c=parseInt(r,10);
 * if(!isNaN(c))return Math.max(c*1000,i)}return i}`）：base=min(500·
 * 2^(attempt-1), capMs) ×(1+rand·0.25) 上抖动后 round；retry-after 秒数走
 * **max-merge**（max(c*1000, i)），与内层建立面 retryRequest 的
 * “头字段全量覆盖”（computeBackoffDelayMs，同 0032 retryRequest 原文）是
 * 两套共存面：429/循环层重试路径用本曲线，其余建立面维持 retryRequest 版。
 */
function computeLoopBackoffDelayMs(
  error: unknown,
  attempt: number,
  capMs: number,
): number {
  const baseMs = Math.min(500 * 2 ** (attempt - 1), capMs)
  const jittered = Math.round(baseMs + Math.random() * 0.25 * baseMs)
  const retryAfterSeconds = retryAfterSecondsOf(error)
  if (retryAfterSeconds !== undefined) {
    return Math.max(retryAfterSeconds * 1000, jittered)
  }
  return jittered
}

/** 服务端 retry-after（秒）——官方 XD 的 r 参（iIe 等价：原样秒数串）。 */
function retryAfterSecondsOf(error: unknown): number | undefined {
  const asSeconds = errHeaderOf(error, 'retry-after')
  if (asSeconds === undefined) return undefined
  const seconds = Number.parseFloat(asSeconds)
  return Number.isNaN(seconds) ? undefined : seconds
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
   * Official per-request auth flag (W2.11, 0032-chunk-dyqmyxqn/
   * module-005-uncategorized.js:706 `_authFlags`/`authHeaders`/`shouldRetry`
   * 原文)：请求建模是否实际从 token cache 取了签发凭据。官方 401 门
   * `if(e.status===401&&this._authState.tokenCache&&n.usedTokenCache&&
   * !n.didRefreshFor401)return n.didRefreshFor401=!0,this._authState.
   * tokenCache.invalidate(),!0` —— 仅「该请求真的用过缓存凭据」才放行
   * 单次 401 刷新重试。codex/OpenAI 的 ChatGPT 路径在每次 establishment
   * 都经 getValidChatGPTAuth() 从缓存放签发凭据（responsesAdapter），置位
   * 封闭在调用点。缺省（无 per-request 标记的调用点）保留会话级放宽
   * isChatGPTAuthEnabled() 作 fallback——官方门为本函数注释所引原文，
   * fallback 是 CCH 单面的保守放宽（取舍声明）。
   */
  usedTokenCache?: () => boolean
  /** 官方 shouldRetry 401 路的 `tokenCache.invalidate()` 等价面：401 刷新
   * 重试前失效旧缓存（CCH 的 codex client 缓存随 access token 键重建）。 */
  invalidateTokenCache?: () => void
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

/**
 * 外层轮次类判（W2.10）：官方 FHt（0001-chunk-xrzcaagk/module-006-
 * uncategorized.js:7495）原文 `function FHt(e){if(e===void 0)return!1;
 * if(e==="wall_clock_timeout"||e==="connection_timeout"||
 * e==="connection_error")return!0;let n=e.match(/^http_(\d{3})/);if(n){
 * let r=Number(n[1]);return r===429||r>=500&&r<600}return!1}` — 原文
 * 外层循环（:7495 vWo 面 `for(Er=1;Er<=zo;Er++){if(g.aborted||!Fo.unavailable
 * ||!FHt(Fo.errorKind)||Fo.errorKind?.endsWith("_no_retry")||
 * Fo.retryAfterMs!==void 0)break;...}`）的参检类：timeout / connection /
 * http_429 / http_5xx 全在类内。CCH 的 timeout/connection 姿态由
 * isConnectionClassError（含 timeout-class 回退）承载，http_429/5xx 按
 * status 码判定；529/overloaded_error 体面（rP）保留为显式成员。
 */
function isOuterRetryClassError(error: unknown): boolean {
  if (isUnavailableOverloadedError(error)) return true
  if (isConnectionClassError(error)) return true
  const status = errStatusOf(error)
  return (
    status === 429 || (status !== undefined && status >= 500 && status < 600)
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
  // Retry gate（官方 module-006 循环层两分支，W2.8／W2.9 原文核对：
  // 0001:6798 `if(Tn){U++;let zo=null;if(bt instanceof Pt&&bt.status===429){
  // if(zo=pCo(bt,g),zo!==null&&...rejected)yn=bt}un=zo??Math.min(XD(U,qn,
  // UEo,r.random),oIe)}else if(VM(bt))un=AEo;else if(zn)un=NEo;else if(
  // un=XD(nt+U,qn,void 0,r.random),Pq())un=Math.min(un,oIe),Xt=!0;else if(
  // un>$Eo)throw ...tengu_api_retry_after_too_long...`）：
  // - 429 分支**恒** Math.min(XD(UEo), oIe)——原文 429 不读 Pq/$Eo，熔断
  //   从不存在（「429 官方循环层恒 min(oIe) 无熔断」，Q2 复核确认）。
  // - 非 429 分支：watchdog on（Pq）→ min(un, oIe=6h)（补 cap 的"未 cap
  //   侧"——上一版 watchdog-on 直放是真偏差）；watchdog off → un>$Eo 抛。
  const gateDelayMs = (ms: number, failure: unknown): number => {
    if (errStatusOf(failure) === 429) {
      return Math.min(ms, OIe_LOOP_DELAY_CAP_MS)
    }
    if (isRetryWatchdogOn(process.env)) {
      return Math.min(ms, OIe_LOOP_DELAY_CAP_MS)
    }
    if (ms > RETRY_AFTER_TOO_LONG_MS) {
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
        // W2.9 两套共存面：429 的循环层延迟走 XD max-merge 曲线（0032:592
        // + module-006 `un=zo??Math.min(XD(U,qn,UEo),oIe)`——retry-after
        // max(c*1000, i) 合并、UEo=300000 base cap），其余建立面维持
        // retryRequest 版（头字段全量覆盖）。
        const retryInMs = gateDelayMs(
          errStatusOf(error) === 429
            ? computeLoopBackoffDelayMs(error, attempt, Ueo_429_LOOP_CAP_MS)
            : computeBackoffDelayMs(error, attempt),
          error,
        )
        logForDebugging(
          `connection ${timedOut ? 'timed out' : 'failed'} - retrying, ${remaining} attempts remaining${options.source ? ` (${options.source})` : ''}`,
        )
        options.onRetryStatus?.(retryStatus(attempt, retryInMs, error))
        if (!(await sleepBeforeRetry(retryInMs))) throw error
        continue
      }
      // 401 refresh gate — official per-request semantics (W2.11,
      // 0032-chunk-dyqmyxqn/module-005-uncategorized.js:706 `shouldRetry`
      // 原文: `if(e.status===401&&this._authState.tokenCache&&
      // n.usedTokenCache&&!n.didRefreshFor401)return n.didRefreshFor401
      // =!0,this._authState.tokenCache.invalidate(),!0`)：仅当本请求实际
      // 从 token cache 取过凭据（usedTokenCache 标记，codex/OpenAI 的
      // getValidChatGPTAuth 缓存读取面）且未在本请求刷新过，才重试一次，
      // 重试前 invalidate 旧缓存。无 per-request 标记的调用点保留会话级
      // 放宽 isChatGPTAuthEnabled() 作 fallback（会话级放宽与官方门的
      // 取舍已在 ConnectionRetryOptions.usedTokenCache 注释声明）。
      const usedTokenCacheFlag =
        options.usedTokenCache !== undefined
          ? options.usedTokenCache() === true
          : isChatGPTAuthEnabled()
      if (
        errStatusOf(error) === 401 &&
        !authRefreshRetrySpent &&
        !options.signal?.aborted &&
        usedTokenCacheFlag
      ) {
        authRefreshRetrySpent = true
        options.invalidateTokenCache?.()
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
      // Official outer-retry face (module-006 vWo() unavailableOuterRetries,
      // :7495 循环原文): past the exhausted inner budget, N more rounds
      // (default vZe=0 — off) while the error stays in the FHt class
      // (W2.10: timeout/connection/http_429/5xx — 非仅 529+overloaded)。
      // 官方 4 句 break 连词的 CCH 对应：aborted（signal）、非类内
      // （isOuterRetryClassError）、`Fo.retryAfterMs!==void 0`（服务端已
      // 给出等待时长 → 不再外层补轮）、`_no_retry` 后缀类（等价
      // x-should-retry veto → isProviderConnectionRetryable 拒绝）。每轮
      // 走 classifier-face 曲线（min(TZe·2^(n-1), EZe) + floored additive
      // jitter），独立于内层 SDK 曲线。
      const outerRound = attempt - maxRetries
      if (
        outerRound > outerRetries ||
        options.signal?.aborted ||
        !isOuterRetryClassError(error) ||
        retryAfterMs(error) !== undefined ||
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
