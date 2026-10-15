/**
 * SDK heap dump monitor — makes the auto-1.5GB heap dump path observable.
 *
 * Periodically samples process.memoryUsage() (default every 60s) and, when
 * heapUsed crosses the auto-dump threshold (default 1.5GB, aligned with the
 * high-memory threshold in useMemoryUsage), triggers the existing
 * heapDumpService.performHeapDump('auto-1.5GB', dumpNumber) entry point.
 * It deliberately does NOT roll its own snapshot logic: all snapshot I/O,
 * diagnostics and analytics stay in heapDumpService.
 *
 * Re-entrancy: at most one auto dump is in flight at any time (AutoHeapDumpGate
 * below). heapDumpService itself has no concurrent-call protection, so the
 * monitor gate is what serializes the auto path against itself.
 *
 * All output goes through logForDebugging — zero noise unless debug logging
 * is enabled. Startup is gated on process.env.USER_TYPE === 'ant' by the
 * caller (main.tsx), not here.
 */
import { logForDebugging } from './debug.js'
import { toError } from './errors.js'
import { formatFileSize } from './format.js'
import type { HeapDumpResult } from './heapDumpService.js'

export const SDK_MEMORY_MONITOR_INTERVAL_MS = 60_000
export const SDK_MEMORY_MONITOR_MIN_INTERVAL_MS = 1_000
/** Aligned with useMemoryUsage's HIGH_MEMORY_THRESHOLD (1.5GB). */
export const SDK_HEAP_DUMP_AUTO_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024

export type HeapDumpTimerHandle = { unref?: () => void }

export type AutoHeapDumpTrigger = (
  dumpNumber: number,
) => Promise<HeapDumpResult>

export type SdkHeapDumpMonitorDeps = {
  /** Sample cadence in ms. Default 60_000; values below 1s fall back to it. */
  intervalMs?: number
  /** heapUsed threshold in bytes. Default SDK_HEAP_DUMP_AUTO_THRESHOLD_BYTES. */
  thresholdBytes?: number
  /** Default: () => process.memoryUsage().heapUsed */
  getHeapUsedBytes?: () => number
  /** Default: lazy import of heapDumpService.performHeapDump('auto-1.5GB', n) */
  triggerDump?: AutoHeapDumpTrigger
  setTimer?: (callback: () => void, ms: number) => HeapDumpTimerHandle | number
  clearTimer?: (handle: HeapDumpTimerHandle | number) => void
}

export type SdkHeapDumpMonitor = {
  start(): void
  stop(): void
  isRunning(): boolean
}

/** Pure: trigger decision. Inclusive boundary — exactly at threshold dumps. */
export function shouldTriggerAutoHeapDump(
  heapUsedBytes: number,
  thresholdBytes: number,
): boolean {
  return heapUsedBytes >= thresholdBytes
}

/** Pure: fall back to the default interval for invalid values. */
export function resolveMonitorIntervalMs(intervalMs?: number): number {
  if (
    typeof intervalMs !== 'number' ||
    !Number.isFinite(intervalMs) ||
    intervalMs < SDK_MEMORY_MONITOR_MIN_INTERVAL_MS
  ) {
    return SDK_MEMORY_MONITOR_INTERVAL_MS
  }
  return intervalMs
}

/** Pure: fall back to the default threshold for invalid values. */
export function resolveAutoThresholdBytes(thresholdBytes?: number): number {
  if (
    typeof thresholdBytes !== 'number' ||
    !Number.isFinite(thresholdBytes) ||
    thresholdBytes <= 0
  ) {
    return SDK_HEAP_DUMP_AUTO_THRESHOLD_BYTES
  }
  return thresholdBytes
}

/**
 * Serializes auto dumps: only one performHeapDump may run at a time, and each
 * gets the next session-local dump number. 1-based — 0 is reserved for manual
 * dumps per the dumpNumber docs in heapDumpService.MemoryDiagnostics.
 */
export class AutoHeapDumpGate {
  private inFlight = false
  private nextNumber = 1

  /**
   * Acquire the single dump slot. Returns the dump number to use, or null
   * when a dump is already in flight.
   */
  tryBegin(): number | null {
    if (this.inFlight) return null
    this.inFlight = true
    return this.nextNumber++
  }

  end(): void {
    this.inFlight = false
  }

  isDumpInFlight(): boolean {
    return this.inFlight
  }
}

/**
 * Engine for the memory monitor. Self-scheduling; injectable clock/timers and
 * dump trigger so tests can drive the loop with a fake clock instead of
 * sleeping and without hitting the real heapDumpService.
 */
export function createSdkHeapDumpMonitor(
  deps: SdkHeapDumpMonitorDeps = {},
): SdkHeapDumpMonitor {
  const intervalMs = resolveMonitorIntervalMs(deps.intervalMs)
  const thresholdBytes = resolveAutoThresholdBytes(deps.thresholdBytes)
  const getHeapUsedBytes =
    deps.getHeapUsedBytes ?? (() => process.memoryUsage().heapUsed)
  const triggerDump: AutoHeapDumpTrigger =
    deps.triggerDump ??
    (dumpNumber =>
      import('./heapDumpService.js').then(m =>
        m.performHeapDump('auto-1.5GB', dumpNumber),
      ))
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      timer.unref()
      return timer
    })
  const clearTimer =
    deps.clearTimer ??
    ((handle: HeapDumpTimerHandle | number) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>))

  const gate = new AutoHeapDumpGate()
  let running = false
  let timer: HeapDumpTimerHandle | number | undefined

  function scheduleNext(): void {
    if (!running) return
    const handle = setTimer(tick, intervalMs)
    if (typeof handle === 'object') {
      handle.unref?.()
    }
    timer = handle
  }

  function tick(): void {
    timer = undefined
    if (!running) return
    try {
      sample()
    } catch (err) {
      logForDebugging(
        `[SdkHeapDumpMonitor] sample failed: ${toError(err).message}`,
      )
    }
    scheduleNext()
  }

  function sample(): void {
    const heapUsedBytes = getHeapUsedBytes()
    if (!shouldTriggerAutoHeapDump(heapUsedBytes, thresholdBytes)) {
      return
    }
    const dumpNumber = gate.tryBegin()
    if (dumpNumber === null) {
      logForDebugging(
        `[SdkHeapDumpMonitor] heapUsed ${formatFileSize(heapUsedBytes)} above threshold but an auto dump is already in flight — skipping`,
      )
      return
    }
    logForDebugging(
      `[SdkHeapDumpMonitor] heapUsed ${formatFileSize(heapUsedBytes)} >= threshold ${formatFileSize(thresholdBytes)} — triggering auto heap dump #${dumpNumber}`,
    )
    // Call synchronously (guarded) so dump numbering is observable at the
    // call site; settle handling continues on the promise chain below.
    let dumpPromise: Promise<HeapDumpResult>
    try {
      dumpPromise = triggerDump(dumpNumber)
    } catch (err) {
      gate.end()
      logForDebugging(
        `[SdkHeapDumpMonitor] auto dump #${dumpNumber} threw: ${toError(err).message}`,
      )
      return
    }
    void dumpPromise
      .then(result => {
        if (result.success) {
          logForDebugging(
            `[SdkHeapDumpMonitor] auto dump #${dumpNumber} written to ${result.heapPath ?? 'unknown'}`,
          )
        } else {
          logForDebugging(
            `[SdkHeapDumpMonitor] auto dump #${dumpNumber} failed: ${result.error ?? 'unknown error'}`,
          )
        }
      })
      .catch((err: unknown) => {
        logForDebugging(
          `[SdkHeapDumpMonitor] auto dump #${dumpNumber} threw: ${toError(err).message}`,
        )
      })
      .finally(() => {
        gate.end()
      })
  }

  return {
    start(): void {
      if (running) return
      running = true
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
  }
}

let monitor: SdkHeapDumpMonitor | undefined

export function startSdkMemoryMonitor(deps: SdkHeapDumpMonitorDeps = {}): void {
  if (!monitor) {
    monitor = createSdkHeapDumpMonitor(deps)
    logForDebugging(
      `[SdkHeapDumpMonitor] started (interval ${resolveMonitorIntervalMs(deps.intervalMs)}ms, threshold ${formatFileSize(resolveAutoThresholdBytes(deps.thresholdBytes))})`,
    )
  }
  monitor.start()
}

export function stopSdkMemoryMonitor(): void {
  monitor?.stop()
}

/** For tests only — clears module-level monitor state. */
export function _resetSdkMemoryMonitorForTesting(): void {
  monitor?.stop()
  monitor = undefined
}
