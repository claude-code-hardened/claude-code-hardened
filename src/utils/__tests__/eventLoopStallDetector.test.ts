/**
 * Tests for eventLoopStallDetector.ts
 * Pure stall math (lag, threshold, event assembly) plus the self-scheduling
 * probe loop driven by an injected fake clock/scheduler — no real sleeping.
 */
import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../tests/mocks/debug'

mock.module('src/utils/debug.ts', debugMock)

// Lazy import after mock.module: static imports are hoisted above the mock
// registration, and the real debug.ts chain reaches analytics code that is
// unavailable under bun test (missing @opentelemetry/resources).
const {
  EVENT_LOOP_PROBE_INTERVAL_MS,
  EVENT_LOOP_STALL_HISTORY_SIZE,
  EVENT_LOOP_STALL_THRESHOLD_MS,
  buildStallEvent,
  computeEventLoopLag,
  createEventLoopStallMonitor,
  getLatestEventLoopStall,
  getRecentEventLoopStalls,
  isEventLoopStall,
  resolveHistorySize,
  resolveProbeIntervalMs,
  resolveStallThresholdMs,
  startEventLoopStallDetector,
  stopEventLoopStallDetector,
} = await import('../eventLoopStallDetector')

// Type-only, elided at runtime.
type EventLoopMonitorDeps =
  import('../eventLoopStallDetector').EventLoopMonitorDeps
type EventLoopStallEvent =
  import('../eventLoopStallDetector').EventLoopStallEvent
type EventLoopTimerHandle =
  import('../eventLoopStallDetector').EventLoopTimerHandle

type FakeHandle = {
  id: number
  callback: () => void
  ms: number
  unrefed: boolean
  cleared: boolean
  unref(): void
}

function createFakeScheduler() {
  const pending: FakeHandle[] = []
  const all: FakeHandle[] = []
  const setTimer = (callback: () => void, ms: number): FakeHandle => {
    const handle: FakeHandle = {
      id: all.length + 1,
      callback,
      ms,
      unrefed: false,
      cleared: false,
      unref() {
        this.unrefed = true
      },
    }
    all.push(handle)
    pending.push(handle)
    return handle
  }
  const clearTimer = (handle: EventLoopTimerHandle | number): void => {
    const target =
      typeof handle === 'number'
        ? all.find(h => h.id === handle)
        : all.find(h => h === handle)
    if (!target) return
    target.cleared = true
    const i = pending.indexOf(target)
    if (i >= 0) pending.splice(i, 1)
  }
  const fireNext = (): void => {
    const next = pending.shift()
    if (!next) throw new Error('no pending timer to fire')
    next.callback()
  }
  return { all, pending, setTimer, clearTimer, fireNext }
}

/**
 * Harness with a manual clock: tests advance `clock.value` and fire the
 * pending probe manually — simulating both healthy loops and stalls without
 * any real time passing.
 */
function createHarness(overrides: Partial<EventLoopMonitorDeps> = {}): {
  monitor: ReturnType<typeof createEventLoopStallMonitor>
  sched: ReturnType<typeof createFakeScheduler>
  clock: { value: number }
  epoch: { value: number }
} {
  const clock = { value: 0 }
  const epoch = { value: 1_700_000_000_000 }
  const sched = createFakeScheduler()
  const monitor = createEventLoopStallMonitor({
    thresholdMs: 1_000,
    intervalMs: 500,
    now: () => clock.value,
    dateNow: () => epoch.value,
    memoryUsage: () => ({ rss: 100, heapUsed: 50, heapTotal: 80 }),
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    ...overrides,
  })
  return { monitor, sched, clock, epoch }
}

/** Fire a probe that is `lateMs` later than its due time. */
function fireLate(
  clock: { value: number },
  sched: ReturnType<typeof createFakeScheduler>,
  intervalMs: number,
  lateMs: number,
): void {
  clock.value += intervalMs + lateMs
  sched.fireNext()
}

describe('computeEventLoopLag', () => {
  test('fired after due → lag is the lateness', () => {
    expect(computeEventLoopLag(1000, 1250)).toBe(250)
  })

  test('fired early or exactly on time → lag clamps to 0', () => {
    expect(computeEventLoopLag(1000, 999)).toBe(0)
    expect(computeEventLoopLag(1000, 1000)).toBe(0)
  })
})

describe('isEventLoopStall', () => {
  test('exactly at threshold counts as a stall (inclusive)', () => {
    expect(isEventLoopStall(1_000, 1_000)).toBe(true)
  })

  test('below threshold is not a stall', () => {
    expect(isEventLoopStall(999, 1_000)).toBe(false)
  })
})

describe('buildStallEvent', () => {
  test('duration comes from fired - due, epoch stamps bracket it', () => {
    const event = buildStallEvent({
      dueAtMs: 5_000,
      firedAtMs: 6_250,
      detectedAtEpochMs: 1_700_000_000_000,
      memory: { rss: 300, heapUsed: 120, heapTotal: 250 },
    })
    expect(event.durationMs).toBe(1_250)
    expect(event.detectedAtEpochMs).toBe(1_700_000_000_000)
    expect(event.startedAtEpochMs).toBe(1_700_000_000_000 - 1_250)
    expect(event.rss).toBe(300)
    expect(event.heapUsed).toBe(120)
    expect(event.heapTotal).toBe(250)
  })

  test('negative lag clamps to zero-length event', () => {
    const event = buildStallEvent({
      dueAtMs: 5_000,
      firedAtMs: 4_000,
      detectedAtEpochMs: 1_700_000_000_000,
      memory: { rss: 0, heapUsed: 0, heapTotal: 0 },
    })
    expect(event.durationMs).toBe(0)
    expect(event.startedAtEpochMs).toBe(event.detectedAtEpochMs)
  })
})

describe('resolveStallThresholdMs / resolveProbeIntervalMs / resolveHistorySize', () => {
  test('defaults are 1s threshold, 1s probe interval, 20 history slots', () => {
    expect(EVENT_LOOP_STALL_THRESHOLD_MS).toBe(1_000)
    expect(EVENT_LOOP_PROBE_INTERVAL_MS).toBe(1_000)
    expect(EVENT_LOOP_STALL_HISTORY_SIZE).toBe(20)
    expect(resolveStallThresholdMs(undefined)).toBe(1_000)
    expect(resolveProbeIntervalMs(undefined)).toBe(1_000)
    expect(resolveHistorySize(undefined)).toBe(20)
  })

  test('valid values pass through', () => {
    expect(resolveStallThresholdMs(500)).toBe(500)
    expect(resolveProbeIntervalMs(250)).toBe(250)
    expect(resolveHistorySize(5)).toBe(5)
  })

  test('invalid values fall back to defaults', () => {
    expect(resolveStallThresholdMs(0)).toBe(1_000)
    expect(resolveStallThresholdMs(-5)).toBe(1_000)
    expect(resolveStallThresholdMs(Number.NaN)).toBe(1_000)
    expect(resolveProbeIntervalMs(9)).toBe(1_000)
    expect(resolveProbeIntervalMs(Number.POSITIVE_INFINITY)).toBe(1_000)
    expect(resolveHistorySize(0)).toBe(20)
    expect(resolveHistorySize(2.9)).toBe(2)
  })
})

describe('createEventLoopStallMonitor', () => {
  test('healthy loop records no stalls and keeps exactly one probe pending', () => {
    const { monitor, sched, clock } = createHarness()
    monitor.start()
    fireLate(clock, sched, 500, 0)
    fireLate(clock, sched, 500, 0)
    expect(monitor.getRecentStalls()).toEqual([])
    expect(monitor.getLatestStall()).toBeNull()
    expect(sched.pending).toHaveLength(1)
    monitor.stop()
  })

  test('late probe above threshold is recorded with duration and snapshot', () => {
    const { monitor, sched, clock, epoch } = createHarness()
    monitor.start()
    fireLate(clock, sched, 500, 0) // healthy first probe
    clock.value += 500 + 1_200 // second probe fires 1200ms late
    sched.fireNext()
    const stalls = monitor.getRecentStalls()
    expect(stalls).toHaveLength(1)
    const stall = stalls[0]!
    expect(stall.durationMs).toBe(1_200)
    expect(stall.detectedAtEpochMs).toBe(epoch.value)
    expect(stall.startedAtEpochMs).toBe(epoch.value - 1_200)
    expect(stall.rss).toBe(100)
    expect(stall.heapUsed).toBe(50)
    expect(stall.heapTotal).toBe(80)
    monitor.stop()
  })

  test('lag exactly at threshold records, one below does not', () => {
    const { monitor, sched, clock } = createHarness()
    monitor.start()
    fireLate(clock, sched, 500, 0)
    fireLate(clock, sched, 500, 999)
    expect(monitor.getRecentStalls()).toEqual([])
    fireLate(clock, sched, 500, 1_000)
    expect(monitor.getRecentStalls()).toHaveLength(1)
    monitor.stop()
  })

  test('after a stall, the next on-time probe records nothing new', () => {
    const { monitor, sched, clock } = createHarness()
    monitor.start()
    fireLate(clock, sched, 500, 1_500)
    fireLate(clock, sched, 500, 0)
    const stalls = monitor.getRecentStalls()
    expect(stalls).toHaveLength(1)
    expect(stalls[0]!.durationMs).toBe(1_500)
    monitor.stop()
  })

  test('getRecentStalls caps history at the configured size, newest last', () => {
    const { monitor, sched, clock } = createHarness({ historySize: 2 })
    monitor.start()
    fireLate(clock, sched, 500, 1_000)
    fireLate(clock, sched, 500, 1_200)
    fireLate(clock, sched, 500, 1_400)
    expect(monitor.getRecentStalls()).toHaveLength(2)
    expect(monitor.getRecentStalls()[0]!.durationMs).toBe(1_200)
    expect(monitor.getRecentStalls()[1]!.durationMs).toBe(1_400)
    expect(monitor.getLatestStall()!.durationMs).toBe(1_400)
    expect(monitor.getRecentStalls(1)).toEqual([
      monitor.getLatestStall() as EventLoopStallEvent,
    ])
    monitor.stop()
  })

  test('registerStallListener receives events and can unsubscribe', () => {
    const { monitor, sched, clock } = createHarness()
    const seen: EventLoopStallEvent[] = []
    const unsubscribe = monitor.registerStallListener(event => {
      seen.push(event)
    })
    monitor.start()
    fireLate(clock, sched, 500, 1_000)
    expect(seen).toHaveLength(1)
    unsubscribe()
    fireLate(clock, sched, 500, 1_000)
    expect(seen).toHaveLength(1)
    monitor.stop()
  })

  test('a throwing listener does not break the loop or other listeners', () => {
    const { monitor, sched, clock } = createHarness()
    const seen: EventLoopStallEvent[] = []
    monitor.registerStallListener(() => {
      throw new Error('observer crashed')
    })
    monitor.registerStallListener(event => {
      seen.push(event)
    })
    monitor.start()
    fireLate(clock, sched, 500, 1_000)
    fireLate(clock, sched, 500, 1_000)
    expect(seen).toHaveLength(2)
    expect(sched.pending).toHaveLength(1)
    monitor.stop()
  })

  test('start is idempotent — one probe at a time', () => {
    const { monitor, sched } = createHarness()
    monitor.start()
    monitor.start()
    monitor.start()
    expect(sched.pending).toHaveLength(1)
    monitor.stop()
  })

  test('stop clears the pending probe (unref + clear) and resets running', () => {
    const { monitor, sched, clock } = createHarness()
    monitor.start()
    const handle = sched.pending[0]!
    monitor.stop()
    expect(handle.cleared).toBe(true)
    expect(sched.pending).toHaveLength(0)
    expect(monitor.isRunning()).toBe(false)
    // A cleared probe firing late must do nothing.
    sched.all[0]!.callback()
    expect(monitor.getRecentStalls()).toEqual([])
    void clock
  })

  test('restart after stop rearms the loop', () => {
    const { monitor, sched, clock } = createHarness()
    monitor.start()
    monitor.stop()
    monitor.start()
    expect(monitor.isRunning()).toBe(true)
    expect(sched.pending).toHaveLength(1)
    fireLate(clock, sched, 500, 1_000)
    expect(monitor.getLatestStall()!.durationMs).toBe(1_000)
    monitor.stop()
  })

  test('probe timer with default deps is unref\u00aded via injected scheduler', () => {
    const { monitor, sched } = createHarness()
    monitor.start()
    expect(sched.pending[0]!.unrefed).toBe(true)
    monitor.stop()
  })
})

describe('module-level API', () => {
  test('start/query/stop lifecycle without sleeping', () => {
    startEventLoopStallDetector({ intervalMs: 600_000 })
    expect(getRecentEventLoopStalls()).toEqual([])
    expect(getLatestEventLoopStall()).toBeNull()
    stopEventLoopStallDetector()
  })

  test('queries before any start lazily create a monitor', () => {
    expect(getRecentEventLoopStalls(5)).toEqual([])
    expect(getLatestEventLoopStall()).toBeNull()
    stopEventLoopStallDetector()
  })

  test('start after stop rearms the singleton', () => {
    startEventLoopStallDetector({ intervalMs: 600_000 })
    stopEventLoopStallDetector()
    startEventLoopStallDetector({ intervalMs: 600_000 })
    stopEventLoopStallDetector()
  })
})
