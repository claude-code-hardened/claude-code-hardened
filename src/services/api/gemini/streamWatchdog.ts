/**
 * Streaming idle watchdog + in-flight request registry for the Gemini
 * compatible layer.
 *
 * Mirrors the OpenAI layer's streamWatchdog.ts (same env var, same defaults,
 * same registry surface). Why this exists: the hand-rolled fetch/SSE client
 * this layer used before the @google/genai SDK migration had no stall
 * protection — a relay that accepted the request and then stopped sending
 * bytes mid-SSE left the reader's async frame awaiting a body read forever.
 * Nothing ever settled, so the async generator frame was rooted by that
 * pending Promise and — along with it — the full request body stayed resident
 * (measured: 68.6MB/h linear growth across heapdump snapshots).
 *
 * A total-duration SDK `timeout` cannot fix this: it would kill long *healthy*
 * streaming turns mid-flight. Instead we layer a SILENCE-based watchdog on top
 * of the chunk consumption loop:
 *
 * - every received chunk resets the timer, so healthy long streams never trip
 * - when the silence window expires, the watchdog aborts the AbortController
 *   whose signal was handed to `generateContentStream(config.abortSignal)`,
 *   and the consumption loop lands a structured `StreamIdleTimeoutError`
 *   through the existing error surface — QueryEngine's retry/fallback then
 *   takes over
 * - `CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS` (default 300000; 0 = disabled)
 *
 * Teardown of a stuck stream is abort-driven (never generator `.return()`):
 * that is why the watchdog signal must be passed to the SDK call.
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
// Mirrors the OpenAI layer's registration: the official core hosts the byte
// watchdog gate (mC(): env wins when defined, default ON), its bedrock
// variant, and API_FORCE_IDLE_TIMEOUT on the same streaming-stall face.

/** Official `mC()` gate: env wins when defined; default ON. */
export const BYTE_WATCHDOG_ENV = 'CLAUDE_ENABLE_BYTE_WATCHDOG'

/** CLAUDE_ENABLE_BYTE_WATCHDOG — byte-watchdog on/off (default on). */
export function isByteWatchdogEnabled(): boolean {
  const raw = process.env[BYTE_WATCHDOG_ENV]
  if (raw === undefined) return true
  return isEnvTruthy(raw)
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
  if (raw !== undefined) return isEnvTruthy(raw)
  return isByteWatchdogEnabled()
}

/**
 * Official transport face (reverse-284 `bi()`): API_FORCE_IDLE_TIMEOUT drops
 * the transport-level timeout from API fetches so only a body idle watchdog
 * can kill a stalled connection. The genai SDK here has no request timeout
 * at all and the silence watchdog below is always armed when enabled — the
 * official `hasBodyIdleWatchdog || truthy(env)` r-condition is satisfied
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

// Official-parity establishment guard, mirroring the OpenAI layer
// (CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS): the silence window only arms once
// consumption starts, so a relay that accepts the request and never returns
// headers stalls establishment unbounded (the genai SDK has no request
// timeout). A shorter first-byte window armed at watchdog creation turns
// that stall into an abort the connection retry layer re-arms with a fresh
// per-attempt watchdog.
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

/** Snapshot of the currently in-flight Gemini-layer requests (diagnostics). */
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
      `Gemini stream idle timeout: no stream data received for ` +
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
  /** Pass to the SDK call (config.abortSignal) — watchdog aborts through it. */
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

  // Registered at "started": before the SDK hands out its stream. The entry
  // is deleted by settle() — either from the wrapped stream's finally or from
  // the caller's catch when the SDK call itself throws. settle() is
  // idempotent so both paths always land exactly once (finally 必走).
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
      `[Gemini] Stream idle watchdog: no stream data for ` +
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

  // Silence window starts at watchdog CREATION with the shorter first-byte
  // window (establishment guard); consumption re-arms with the full idle
  // window per chunk. Suppressed entirely when the idle watchdog is
  // disabled (0 = fully off, matching the documented semantics).
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
        // Silence window: restarts on every received chunk. A healthy long
        // stream never trips it; a stalled one lands the structured error.
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
