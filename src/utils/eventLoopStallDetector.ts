/**
 * Event loop stall detector.
 *
 * Self-schedules a setTimeout probe and measures how late it fires relative
 * to when it was due: while the main thread is blocked (sync work, GC,
 * native calls), timer callbacks fire late, and the lateness *is* the stall.
 * Only one probe is pending at a time — each probe re-arms after it fires.
 *
 * Timing uses process.hrtime.bigint() — same convention as profilerBase.ts.
 * Do NOT import perf_hooks here: JSC's Performance marks live in a C++ Vector
 * that never shrinks and leaks in long-running sessions.
 *
 * Stalls above the threshold are recorded with their start epoch, duration
 * and a point-in-time RSS/heap snapshot, plus a debug-only log line — users
 * see nothing unless debug logging is enabled. Observers can subscribe via
 * onEventLoopStall() or read history via getLatestEventLoopStall() /
 * getRecentEventLoopStalls().
 *
 * The probe timer is .unref()'d so the detector never keeps the process
 * alive on exit.
 */
import { toError } from './errors.js'
import { formatFileSize } from './format.js'
import { logForDebugging } from './debug.js'
import { CircularBuffer } from './CircularBuffer.js'

export const EVENT_LOOP_PROBE_INTERVAL_MS = 1_000
export const EVENT_LOOP_STALL_THRESHOLD_MS = 1_000
export const EVENT_LOOP_STALL_HISTORY_SIZE = 20

const MIN_PROBE_INTERVAL_MS = 10
const MIN_STALL_THRESHOLD_MS = 1

export type EventLoopMemorySnapshot = Pick<
  NodeJS.MemoryUsage,
  'rss' | 'heapUsed' | 'heapTotal'
>

export type EventLoopStallEvent = {
  /** Epoch ms when the probe was due — the best estimate of stall start. */
  startedAtEpochMs: number
  /** Epoch ms when the stall was recorded (probe finally ran). */
  detectedAtEpochMs: number
  /** How long the event loop was blocked, in ms. */
  durationMs: number
  rss: number
  heapUsed: number
  heapTotal: number
}

export type EventLoopStallListener = (event: EventLoopStallEvent) => void

export type EventLoopTimerHandle = { unref?: () => void }

export type EventLoopMonitorDeps = {
  /** Minimum blocked time (ms) to record as a stall. Default 1000. */
  thresholdMs?: number
  /** Probe cadence (ms). Default 1000; values below 10 fall back to it. */
  intervalMs?: number
  /** Monotonic clock in ms. Default: process.hrtime.bigint()-based. */
  now?: () => number
  /** Wall clock in epoch ms, for the recorded timestamps. Default: Date.now. */
  dateNow?: () => number
  setTimer?: (callback: () => void, ms: number) => EventLoopTimerHandle | number
  clearTimer?: (handle: EventLoopTimerHandle | number) => void
  memoryUsage?: () => EventLoopMemorySnapshot
  historySize?: number
}

export type EventLoopStallMonitor = {
  start(): void
  stop(): void
  isRunning(): boolean
  registerStallListener(listener: EventLoopStallListener): () => void
  getRecentStalls(count?: number): EventLoopStallEvent[]
  getLatestStall(): EventLoopStallEvent | null
}

/** Pure: lateness of a timer callback vs when it was due (negative clamps to 0). */
export function computeEventLoopLag(
  dueAtMs: number,
  firedAtMs: number,
): number {
  return Math.max(0, firedAtMs - dueAtMs)
}

/** Pure: threshold decision. Inclusive boundary — exactly at threshold stalls. */
export function isEventLoopStall(lagMs: number, thresholdMs: number): boolean {
  return lagMs >= thresholdMs
}

/** Pure: assemble the recorded event from probe timings + memory snapshot. */
export function buildStallEvent(input: {
  dueAtMs: number
  firedAtMs: number
  detectedAtEpochMs: number
  memory: EventLoopMemorySnapshot
}): EventLoopStallEvent {
  const durationMs = computeEventLoopLag(input.dueAtMs, input.firedAtMs)
  return {
    startedAtEpochMs: input.detectedAtEpochMs - durationMs,
    detectedAtEpochMs: input.detectedAtEpochMs,
    durationMs,
    rss: input.memory.rss,
    heapUsed: input.memory.heapUsed,
    heapTotal: input.memory.heapTotal,
  }
}

/** Pure: fall back to the default threshold for invalid values. */
export function resolveStallThresholdMs(thresholdMs?: number): number {
  if (
    typeof thresholdMs !== 'number' ||
    !Number.isFinite(thresholdMs) ||
    thresholdMs < MIN_STALL_THRESHOLD_MS
  ) {
    return EVENT_LOOP_STALL_THRESHOLD_MS
  }
  return thresholdMs
}

/** Pure: fall back to the default probe interval for invalid values. */
export function resolveProbeIntervalMs(intervalMs?: number): number {
  if (
    typeof intervalMs !== 'number' ||
    !Number.isFinite(intervalMs) ||
    intervalMs < MIN_PROBE_INTERVAL_MS
  ) {
    return EVENT_LOOP_PROBE_INTERVAL_MS
  }
  return intervalMs
}

/** Pure: at least one history slot; fall back to the default for invalid values. */
export function resolveHistorySize(historySize?: number): number {
  if (
    typeof historySize !== 'number' ||
    !Number.isFinite(historySize) ||
    historySize < 1
  ) {
    return EVENT_LOOP_STALL_HISTORY_SIZE
  }
  return Math.floor(historySize)
}

function defaultNow(): number {
  // Monotonic ms since process start — avoid perf_hooks (JSC leak, see above).
  return Number(process.hrtime.bigint() / 1000n) / 1000
}

function defaultMemorySnapshot(): EventLoopMemorySnapshot {
  const usage = process.memoryUsage()
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
  }
}

/**
 * Engine for the stall detector. Self-scheduling; injectable clock/timers so
 * tests can drive the loop with a fake clock instead of sleeping.
 */
export function createEventLoopStallMonitor(
  deps: EventLoopMonitorDeps = {},
): EventLoopStallMonitor {
  const thresholdMs = resolveStallThresholdMs(deps.thresholdMs)
  const intervalMs = resolveProbeIntervalMs(deps.intervalMs)
  const historySize = resolveHistorySize(deps.historySize)
  const now = deps.now ?? defaultNow
  const dateNow = deps.dateNow ?? (() => Date.now())
  const memoryUsage = deps.memoryUsage ?? defaultMemorySnapshot
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      timer.unref()
      return timer
    })
  const clearTimer =
    deps.clearTimer ??
    ((handle: EventLoopTimerHandle | number) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>))

  const history = new CircularBuffer<EventLoopStallEvent>(historySize)
  const listeners = new Set<EventLoopStallListener>()
  let running = false
  let timer: EventLoopTimerHandle | number | undefined
  let dueAtMs = 0

  function scheduleNext(): void {
    if (!running) return
    const handle = setTimer(tick, intervalMs)
    if (typeof handle === 'object') {
      handle.unref?.()
    }
    timer = handle
  }

  function recordStall(firedAtMs: number): void {
    const event = buildStallEvent({
      dueAtMs,
      firedAtMs,
      detectedAtEpochMs: dateNow(),
      memory: memoryUsage(),
    })
    history.add(event)
    logForDebugging(
      `[EventLoopStall] event loop blocked ${event.durationMs}ms (threshold ${thresholdMs}ms); rss=${formatFileSize(event.rss)} heap=${formatFileSize(event.heapUsed)}`,
    )
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (err) {
        logForDebugging(
          `[EventLoopStall] stall listener threw: ${toError(err).message}`,
        )
      }
    }
  }

  function tick(): void {
    if (!running) return
    const firedAtMs = now()
    try {
      const lagMs = computeEventLoopLag(dueAtMs, firedAtMs)
      if (isEventLoopStall(lagMs, thresholdMs)) {
        recordStall(firedAtMs)
      }
    } catch (err) {
      logForDebugging(
        `[EventLoopStall] stall probe failed: ${toError(err).message}`,
      )
    }
    // Measure the next probe from this fire time, so a healthy loop sits at
    // lag≈0 no matter how late this probe was.
    dueAtMs = firedAtMs + intervalMs
    scheduleNext()
  }

  return {
    start(): void {
      if (running) return
      running = true
      dueAtMs = now() + intervalMs
      scheduleNext()
    },
    stop(): void {
      running = false
      if (timer !== undefined) {
        clearTimer(timer)
        timer = undefined
      }
    },
    isRunning(): boolean {
      return running
    },
    registerStallListener(listener: EventLoopStallListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getRecentStalls(count = historySize): EventLoopStallEvent[] {
      return history.getRecent(count)
    },
    getLatestStall(): EventLoopStallEvent | null {
      const recent = history.getRecent(1)
      return recent[0] ?? null
    },
  }
}

let singleton: EventLoopStallMonitor | undefined

export function startEventLoopStallDetector(
  deps: EventLoopMonitorDeps = {},
): void {
  if (!singleton) {
    singleton = createEventLoopStallMonitor(deps)
    logForDebugging(
      `[EventLoopStall] detector started (interval ${resolveProbeIntervalMs(deps.intervalMs)}ms, threshold ${resolveStallThresholdMs(deps.thresholdMs)}ms)`,
    )
  }
  singleton.start()
}

export function stopEventLoopStallDetector(): void {
  singleton?.stop()
}

function requireSingleton(): EventLoopStallMonitor {
  if (!singleton) {
    singleton = createEventLoopStallMonitor()
  }
  return singleton
}

/** Register a callback for future (and query past) stall events. */
export function onEventLoopStall(listener: EventLoopStallListener): () => void {
  return requireSingleton().registerStallListener(listener)
}

export function getLatestEventLoopStall(): EventLoopStallEvent | null {
  return requireSingleton().getLatestStall()
}

export function getRecentEventLoopStalls(
  count = resolveHistorySize(),
): EventLoopStallEvent[] {
  return requireSingleton().getRecentStalls(count)
}
