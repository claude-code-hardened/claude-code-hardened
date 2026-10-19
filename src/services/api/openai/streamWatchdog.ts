/**
 * Streaming idle watchdog + in-flight request registry for the OpenAI
 * compatible layer.
 *
 * Why this exists: a stalled relay (an endpoint that accepts the request and
 * then stops sending bytes mid-SSE) leaves the SDK's async iterator awaiting a
 * body read forever. Nothing ever settles, so the async generator frame is
 * rooted by that pending Promise and — along with it — the full request body
 * stays resident (measured: 68.6MB/h linear growth across heapdump snapshots
 * on a stuck 127.0.0.1 OpenAI-compatible relay).
 *
 * A total-duration SDK `timeout` cannot fix this: it would kill long *healthy*
 * streaming turns mid-flight. Instead we layer a SILENCE-based watchdog on top
 * of the chunk consumption loop:
 *
 * - every received chunk resets the timer, so healthy long streams never trip
 * - when the silence window expires, the watchdog aborts the AbortController
 *   whose signal was handed to `create()`, and the consumption loop lands a
 *   structured `StreamIdleTimeoutError` through the existing error surface —
 *   QueryEngine's retry/fallback then takes over
 * - `CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS` (default 300000; 0 = disabled)
 *
 * Teardown of a stuck stream is abort-driven (never generator `.return()`):
 * that is why the watchdog signal must be passed to the SDK create() call.
 *
 * The module also maintains a registry of in-flight API requests
 * (`getInFlightApiRequests`) so heapdump diagnostics and future debug commands
 * can see which requests were active when memory was captured.
 */

import { randomUUID } from 'crypto'
import { logForDebugging } from '../../../utils/debug.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'

export const STREAM_IDLE_TIMEOUT_ENV = 'CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS'
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Parse CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS. 0 disables the watchdog. */
export function getStreamIdleTimeoutMs(): number {
  const raw = process.env[STREAM_IDLE_TIMEOUT_ENV]
  if (raw === undefined || raw === '') return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  }
  return parsed
}

// ── Official watchdog-gate face (reverse-284, same face as STREAM_WATCHDOG) ──
// The official core registers its streaming-stall envs together: the byte
// watchdog gate (mC(): env wins when defined, default ON via the
// tengu_stream_watchdog_default_on fallback), its bedrock-provider variant,
// and API_FORCE_IDLE_TIMEOUT on the transport face. They are hosted on the
// watchdog module here (the STREAM_WATCHDOG surface of this layer) so the
// whole face stays greppable from one place.

/** Official `mC()` gate: env wins when defined; default ON. */
export const BYTE_WATCHDOG_ENV = 'CLAUDE_ENABLE_BYTE_WATCHDOG'

/** CLAUDE_ENABLE_BYTE_WATCHDOG — byte-watchdog on/off (default on). */
export function isByteWatchdogEnabled(): boolean {
  const raw = process.env[BYTE_WATCHDOG_ENV]
  // W2.7 真 bug 修正（官方 mC() 原文，reverse-284
  // 0004-chunk-zrkp23rq/module-005-uncategorized.js:3979）：
  // `function mC(){let e=a.CLAUDE_ENABLE_BYTE_WATCHDOG;if(e!==void 0)return e;
  // return x("tengu_stream_watchdog_default_on",!0)}` —— env **有定义即原值
  // 语义**（原始字符串自身的 truthy 判定进布尔位：'false' 字符串 → truthy →
  // ON；'' 空串 → falsy → OFF），不做 isEnvTruthy 白名单改写——'0'/'no'
  // 等在官方语义里同属非空 truthy。
  if (raw !== undefined) return Boolean(raw)
  return true
}

/**
 * Official bedrock-provider variant of the byte-watchdog gate
 * (CLAUDE_ENABLE_BYTE_WATCHDOG_BEDROCK). CCH has no bedrock-routed provider
 * on this compatible layer — bedrock runs through the first-party claude.ts
 * face — so the env is registered on this same watchdog face and folded into
 * the provider gate: an explicit value overrides, otherwise the shared
 * CLAUDE_ENABLE_BYTE_WATCHDOG decision applies.
 */
export const BYTE_WATCHDOG_BEDROCK_ENV = 'CLAUDE_ENABLE_BYTE_WATCHDOG_BEDROCK'

/** CLAUDE_ENABLE_BYTE_WATCHDOG_BEDROCK — bedrock variant of the gate. */
export function isByteWatchdogEnabledForBedrock(): boolean {
  const raw = process.env[BYTE_WATCHDOG_BEDROCK_ENV]
  // 官方 gC()（0004 module-005:3342）：`return a.CLAUDE_ENABLE_BYTE_WATCHDOG_
  // BEDROCK` —— 同 mC 的原值 truthy 语义（W2.7）；CCH 折面保留：未设时回退
  // 共享 CLAUDE_ENABLE_BYTE_WATCHDOG 决策（本层无 bedrock 路由，见上注释）。
  if (raw !== undefined) return Boolean(raw)
  return isByteWatchdogEnabled()
}

/**
 * Official transport face (reverse-284 `bi()`): API_FORCE_IDLE_TIMEOUT drops
 * the transport-level timeout from API fetches so only a body idle watchdog
 * can kill a stalled connection. This layer never had a transport body
 * timeout (the SDK `timeout` covers headers only) and the silence watchdog
 * below is always armed when enabled — the official
 * `hasBodyIdleWatchdog || truthy(env)` r-condition is satisfied
 * structurally. The env is registered on this face for parity/diagnostics;
 * isIdleTimeoutForced() marks requests whose authoritative body-stall guard
 * is the idle watchdog, surfaced in watchdog abort logs.
 */
export const API_FORCE_IDLE_TIMEOUT_ENV = 'API_FORCE_IDLE_TIMEOUT'

/** API_FORCE_IDLE_TIMEOUT — idle watchdog is the authoritative body guard. */
export function isIdleTimeoutForced(): boolean {
  const raw = process.env[API_FORCE_IDLE_TIMEOUT_ENV]
  return raw !== undefined && isEnvTruthy(raw)
}

// Official-parity establishment guard (reverse-284:
// CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS): the silence window above only arms
// once consumption starts (wrapped()), so a relay that accepts the request
// and never returns headers stalled the establishment phase unbounded (the
// openai SDK's 600s headers timeout was the only backstop; the gemini SDK
// has none). Arming a shorter first-byte window at watchdog creation turns
// that stall into an abort — a connection-class failure the connection
// retry layer then re-arms with a fresh per-attempt watchdog.
export const STREAM_FIRST_BYTE_TIMEOUT_ENV =
  'CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS'
export const DEFAULT_STREAM_FIRST_BYTE_TIMEOUT_MS = 120_000

/** Parse CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS. 0 disables the guard. */
export function getStreamFirstByteTimeoutMs(): number {
  const raw = process.env[STREAM_FIRST_BYTE_TIMEOUT_ENV]
  if (raw === undefined || raw === '') {
    return DEFAULT_STREAM_FIRST_BYTE_TIMEOUT_MS
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STREAM_FIRST_BYTE_TIMEOUT_MS
  }
  return parsed
}

/** One active API request, kept for diagnostics while it is in flight. */
export type InFlightApiRequest = {
  requestId: string
  url: string
  model: string
  startedAt: number
}

const inFlightRequests = new Map<string, InFlightApiRequest>()

/** Snapshot of the currently in-flight OpenAI-layer requests (diagnostics). */
export function getInFlightApiRequests(): InFlightApiRequest[] {
  return [...inFlightRequests.values()]
}

/** Structured error thrown by the watchdog when the silence window expires. */
export class StreamIdleTimeoutError extends Error {
  readonly model: string
  readonly requestId: string
  readonly idleTimeoutMs: number

  constructor(params: {
    model: string
    requestId: string
    idleTimeoutMs: number
  }) {
    super(
      `OpenAI stream idle timeout: no stream data received for ` +
        `${Math.round(params.idleTimeoutMs / 1000)}s ` +
        `(model=${params.model}, request=${params.requestId}) — the stalled ` +
        `connection was aborted by the idle watchdog`,
    )
    this.name = 'StreamIdleTimeoutError'
    this.model = params.model
    this.requestId = params.requestId
    this.idleTimeoutMs = params.idleTimeoutMs
  }
}

export type StreamWatchdog = {
  /** Stable id (also the registry key) for logs and diagnostics. */
  requestId: string
  /** Pass to the SDK create() call / fetch — watchdog aborts through it. */
  signal: AbortSignal
  /**
   * Wrap the SDK's async iterable with the silence watchdog. Settles the
   * in-flight registry entry when the wrapped stream completes, fails, or is
   * torn down.
   */
  wrap<T>(stream: AsyncIterable<T>): AsyncGenerator<T, void, undefined>
  /**
   * Disarm the creation-time first-byte timer once the SDK call resolved.
   * Consuming the wrapped stream re-arms with the idle window; an abort in
   * the microscopic gap between them would otherwise kill a healthy stream
   * whose establishment ate most of the first-byte window.
   */
  markEstablished(): void
  /** Idempotently remove the request from the in-flight registry. */
  settle(): void
}

function closeIterator(iterator: AsyncIterator<unknown>): void {
  try {
    const returned = iterator.return?.(undefined)
    // Must not be awaited: a stalled stream may never settle its own cleanup.
    if (returned) returned.catch(() => {})
  } catch {
    // Best-effort only.
  }
}

export function createStreamWatchdog(params: {
  url: string
  model: string
  /** Upstream (user/session) abort signal, linked into the watchdog signal. */
  externalSignal?: AbortSignal
  requestId?: string
  /** Test override for the first-byte window (env default otherwise). */
  firstByteTimeoutMs?: number
}): StreamWatchdog {
  const requestId = params.requestId ?? randomUUID()
  const idleTimeoutMs = getStreamIdleTimeoutMs()
  const firstByteTimeoutMs =
    params.firstByteTimeoutMs ?? getStreamFirstByteTimeoutMs()
  // Official mC() gate: the byte watchdog is default-on; the env wins when
  // defined. Gate-off = the documented "0 = disabled" passthrough.
  const byteWatchdogEnabled = isByteWatchdogEnabled()
  const startedAt = Date.now()

  // Registered at "started": before create() hands out its stream. The entry
  // is deleted by settle() — either from the wrapped stream's finally or from
  // the caller's catch when create() itself throws. settle() is idempotent so
  // both paths always land exactly once (finally 必走).
  inFlightRequests.set(requestId, {
    requestId,
    url: params.url,
    model: params.model,
    startedAt,
  })

  let settled = false
  let idleFired = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  // Gate the consumption race on any abort (idle or external link).
  let resolveGate = () => {}
  const idleGate = new Promise<'gate'>(resolve => {
    resolveGate = () => resolve('gate')
  })

  const controller = new AbortController()
  controller.signal.addEventListener('abort', () => resolveGate())
  const externalSignal = params.externalSignal
  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason)
  }
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort()
    else {
      externalSignal.addEventListener('abort', onExternalAbort, {
        once: true,
      })
    }
  }

  function fireIdle(): void {
    if (idleFired || settled) return
    idleFired = true
    logForDebugging(
      `[OpenAI] Stream idle watchdog: no stream data for ` +
        `${Math.round(activeWindowMs / 1000)}s — aborting model=` +
        `${params.model}, request=${requestId}, url=${params.url}, ` +
        `elapsed=${Date.now() - startedAt}ms` +
        // API_FORCE_IDLE_TIMEOUT parity note: the silence watchdog is the
        // sole body-stall guard on this request.
        `${isIdleTimeoutForced() ? ' (API_FORCE_IDLE_TIMEOUT)' : ''}`,
      { level: 'warn' },
    )
    controller.abort(
      new StreamIdleTimeoutError({
        model: params.model,
        requestId,
        idleTimeoutMs: activeWindowMs,
      }),
    )
  }

  // The silence window starts at watchdog CREATION with the shorter
  // first-byte window (establishment guard), then every received chunk
  // re-arms it with the full idle window. A healthy long stream never
  // trips either; an establishment stall aborts before any body exists.
  let activeWindowMs = firstByteTimeoutMs

  function armTimer(): void {
    if (idleFired || settled || controller.signal.aborted) return
    if (idleTimer !== null) clearTimeout(idleTimer)
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      fireIdle,
      activeWindowMs,
    )
    idleTimer = timer
    // Never keep the process alive just for the watchdog.
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (unref) unref.call(timer)
  }

  if (byteWatchdogEnabled && idleTimeoutMs > 0 && firstByteTimeoutMs > 0) {
    // idle=0 or the byte gate off means the watchdog is fully off — the
    // documented "0 = disabled" contract wins over the first-byte guard
    // (no half-armed states).
    armTimer()
  }

  // See the interface doc: called once the SDK create() resolved, so a
  // nearly-spent first-byte window cannot abort a just-established stream
  // in the microscopic gap before consumption re-arms the idle window.
  function markEstablished(): void {
    disarmTimer()
  }

  function disarmTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function watchdogAbortError(): Error {
    if (idleFired) {
      return controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new StreamIdleTimeoutError({
            model: params.model,
            requestId,
            idleTimeoutMs,
          })
    }
    // External abort — surface the abort reason, matching what the SDK stream
    // itself would have thrown had it observed the signal.
    const reason = controller.signal.reason
    if (reason instanceof Error) return reason
    if (reason !== undefined && reason !== null) {
      return new Error(String(reason))
    }
    return new Error('The request was aborted.')
  }

  async function* wrapped<T>(
    stream: AsyncIterable<T>,
  ): AsyncGenerator<T, void, undefined> {
    // A stream was handed out — the first-byte phase is over regardless of
    // which window was armed at creation; the idle cadence takes over (or
    // nothing, when the watchdog is disabled).
    activeWindowMs = idleTimeoutMs
    if (!byteWatchdogEnabled || idleTimeoutMs <= 0) {
      disarmTimer()
      // Watchdog disabled — silent passthrough; still settle the registry.
      try {
        for await (const chunk of stream) {
          yield chunk
        }
      } finally {
        settle()
      }
      return
    }

    const iterator = stream[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        // Silence window: restarts on every received chunk. Switch from the
        // creation-time first-byte window to the full idle window once the
        // stream is established — the first chunk inherits the idle cadence,
        // so a just-narrowed window cannot false-trip a healthy slow start.
        activeWindowMs = idleTimeoutMs
        armTimer()
        const nextPromise = iterator.next()
        const raced = await Promise.race([
          nextPromise.then(result => ({ kind: 'next' as const, result })),
          idleGate.then(() => ({ kind: 'gate' as const })),
        ])
        if (raced.kind === 'gate') {
          // Abandoned next(): swallow its eventual rejection so the aborted
          // body read cannot surface as an unhandled rejection later.
          nextPromise.catch(() => {})
          throw watchdogAbortError()
        }
        if (raced.result.done === true) {
          exhausted = true
          return
        }
        yield raced.result.value
      }
    } finally {
      disarmTimer()
      if (!exhausted) closeIterator(iterator)
      settle()
    }
  }

  function settle(): void {
    if (settled) return
    settled = true
    disarmTimer()
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
    inFlightRequests.delete(requestId)
  }

  return {
    requestId,
    signal: controller.signal,
    wrap: stream => wrapped(stream),
    markEstablished,
    settle,
  }
}
