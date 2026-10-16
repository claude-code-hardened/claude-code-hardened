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
}): StreamWatchdog {
  const requestId = params.requestId ?? randomUUID()
  const idleTimeoutMs = getStreamIdleTimeoutMs()
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
        `${Math.round(idleTimeoutMs / 1000)}s — aborting model=` +
        `${params.model}, request=${requestId}, url=${params.url}, ` +
        `elapsed=${Date.now() - startedAt}ms`,
      { level: 'warn' },
    )
    controller.abort(
      new StreamIdleTimeoutError({
        model: params.model,
        requestId,
        idleTimeoutMs,
      }),
    )
  }

  function armTimer(): void {
    if (idleFired || settled || controller.signal.aborted) return
    if (idleTimer !== null) clearTimeout(idleTimer)
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      fireIdle,
      idleTimeoutMs,
    )
    idleTimer = timer
    // Never keep the process alive just for the watchdog.
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (unref) unref.call(timer)
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
    if (idleTimeoutMs <= 0) {
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
    settle,
  }
}
