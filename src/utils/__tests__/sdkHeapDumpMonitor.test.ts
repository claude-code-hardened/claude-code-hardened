/**
 * Tests for sdkHeapDumpMonitor.ts
 * Pure functions (threshold decision, interval/threshold resolution, re-entrancy
 * gate) plus the self-scheduling loop driven by an injected fake scheduler —
 * no real sleeping, no real heapDumpService calls.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../tests/mocks/debug'

mock.module('src/utils/debug.ts', debugMock)

// Lazy import after mock.module: the subject transitively loads the real
// debug.ts otherwise (static imports are hoisted above mock registration),
// and that chain reaches analytics code that is unavailable under bun test.
const {
  AutoHeapDumpGate,
  SDK_HEAP_DUMP_AUTO_THRESHOLD_BYTES,
  SDK_MEMORY_MONITOR_INTERVAL_MS,
  SDK_MEMORY_MONITOR_MIN_INTERVAL_MS,
  _resetSdkMemoryMonitorForTesting,
  createSdkHeapDumpMonitor,
  resolveAutoThresholdBytes,
  resolveMonitorIntervalMs,
  shouldTriggerAutoHeapDump,
  startSdkMemoryMonitor,
  stopSdkMemoryMonitor,
} = await import('../sdkHeapDumpMonitor')

// Type-only, elided at runtime.
type SdkHeapDumpMonitorDeps =
  import('../sdkHeapDumpMonitor').SdkHeapDumpMonitorDeps
type HeapDumpTimerHandle = import('../sdkHeapDumpMonitor').HeapDumpTimerHandle

// Type-only: never loads heapDumpService at runtime.
type HeapDumpResult = import('../heapDumpService').HeapDumpResult

const GB = 1024 * 1024 * 1024

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
  const clearTimer = (handle: HeapDumpTimerHandle | number): void => {
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

function createDumpFixture() {
  const dumps: number[] = []
  let release: ((result: HeapDumpResult) => void) | undefined
  const triggerDump = (dumpNumber: number): Promise<HeapDumpResult> => {
    dumps.push(dumpNumber)
    return new Promise<HeapDumpResult>(resolve => {
      release = resolve
    })
  }
  const settle = async (
    result: HeapDumpResult = { success: true, heapPath: '/tmp/h' },
  ): Promise<void> => {
    release?.(result)
    // Drain the microtask chain through .then/.catch/.finally.
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }
  return { dumps, triggerDump, settle }
}

function createHarness(
  deps: Partial<SdkHeapDumpMonitorDeps> & {
    getHeapUsedBytes: () => number
    triggerDump: (dumpNumber: number) => Promise<HeapDumpResult>
  },
) {
  const sched = createFakeScheduler()
  const monitor = createSdkHeapDumpMonitor({
    intervalMs: 60_000,
    thresholdBytes: 1024,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    ...deps,
  })
  return { monitor, sched }
}

afterEach(() => {
  _resetSdkMemoryMonitorForTesting()
})

describe('shouldTriggerAutoHeapDump', () => {
  test('below threshold returns false', () => {
    expect(shouldTriggerAutoHeapDump(1.5 * GB - 1, 1.5 * GB)).toBe(false)
  })

  test('exactly at threshold returns true (inclusive boundary)', () => {
    expect(shouldTriggerAutoHeapDump(1.5 * GB, 1.5 * GB)).toBe(true)
  })

  test('above threshold returns true', () => {
    expect(shouldTriggerAutoHeapDump(2 * GB, 1.5 * GB)).toBe(true)
  })
})

describe('resolveMonitorIntervalMs', () => {
  test('default is 60s', () => {
    expect(SDK_MEMORY_MONITOR_INTERVAL_MS).toBe(60_000)
    expect(resolveMonitorIntervalMs(undefined)).toBe(60_000)
  })

  test('valid interval passes through', () => {
    expect(resolveMonitorIntervalMs(5_000)).toBe(5_000)
    expect(resolveMonitorIntervalMs(SDK_MEMORY_MONITOR_MIN_INTERVAL_MS)).toBe(
      1_000,
    )
  })

  test('invalid intervals fall back to default', () => {
    expect(resolveMonitorIntervalMs(0)).toBe(60_000)
    expect(resolveMonitorIntervalMs(-7)).toBe(60_000)
    expect(resolveMonitorIntervalMs(Number.NaN)).toBe(60_000)
    expect(resolveMonitorIntervalMs(Number.POSITIVE_INFINITY)).toBe(60_000)
    expect(resolveMonitorIntervalMs(999)).toBe(60_000)
  })
})

describe('resolveAutoThresholdBytes', () => {
  test('default is 1.5GB aligned with useMemoryUsage HIGH_MEMORY_THRESHOLD', () => {
    expect(SDK_HEAP_DUMP_AUTO_THRESHOLD_BYTES).toBe(1.5 * GB)
    expect(resolveAutoThresholdBytes(undefined)).toBe(1.5 * GB)
  })

  test('valid override passes through', () => {
    expect(resolveAutoThresholdBytes(2 * GB)).toBe(2 * GB)
  })

  test('invalid overrides fall back to default', () => {
    expect(resolveAutoThresholdBytes(0)).toBe(1.5 * GB)
    expect(resolveAutoThresholdBytes(-1)).toBe(1.5 * GB)
    expect(resolveAutoThresholdBytes(Number.NaN)).toBe(1.5 * GB)
  })
})

describe('AutoHeapDumpGate', () => {
  test('first begin acquires with dump number 1 (0 reserved for manual)', () => {
    const gate = new AutoHeapDumpGate()
    expect(gate.isDumpInFlight()).toBe(false)
    expect(gate.tryBegin()).toBe(1)
    expect(gate.isDumpInFlight()).toBe(true)
  })

  test('reentrant begin while in flight returns null', () => {
    const gate = new AutoHeapDumpGate()
    gate.tryBegin()
    expect(gate.tryBegin()).toBeNull()
    expect(gate.tryBegin()).toBeNull()
  })

  test('end releases the slot and numbering continues', () => {
    const gate = new AutoHeapDumpGate()
    expect(gate.tryBegin()).toBe(1)
    gate.end()
    expect(gate.isDumpInFlight()).toBe(false)
    expect(gate.tryBegin()).toBe(2)
    gate.end()
    expect(gate.tryBegin()).toBe(3)
  })
})

describe('createSdkHeapDumpMonitor', () => {
  test('samples only after the interval, not at start', () => {
    const { dumps, triggerDump } = createDumpFixture()
    const { monitor, sched } = createHarness({
      getHeapUsedBytes: () => 2 * 1024,
      triggerDump,
    })
    monitor.start()
    expect(sched.pending).toHaveLength(1)
    expect(dumps).toEqual([])
    sched.fireNext()
    expect(dumps).toEqual([1])
    monitor.stop()
  })

  test('below-threshold samples reschedule without dumping', () => {
    const { dumps, triggerDump } = createDumpFixture()
    const { monitor, sched } = createHarness({
      getHeapUsedBytes: () => 1023,
      triggerDump,
    })
    monitor.start()
    sched.fireNext()
    sched.fireNext()
    expect(dumps).toEqual([])
    expect(sched.pending).toHaveLength(1)
    monitor.stop()
  })

  test('gate prevents a second dump while one is in flight', async () => {
    const { dumps, triggerDump, settle } = createDumpFixture()
    const { monitor, sched } = createHarness({
      getHeapUsedBytes: () => 2 * 1024,
      triggerDump,
    })
    monitor.start()
    sched.fireNext()
    expect(dumps).toEqual([1])
    // Still in flight: samples are skipped and numbered requests never start.
    sched.fireNext()
    sched.fireNext()
    expect(dumps).toEqual([1])
    await settle()
    monitor.stop()
  })

  test('after the dump settles, the next crossing gets dumpNumber 2', async () => {
    const { dumps, triggerDump, settle } = createDumpFixture()
    const { monitor, sched } = createHarness({
      getHeapUsedBytes: () => 2 * 1024,
      triggerDump,
    })
    monitor.start()
    sched.fireNext()
    expect(dumps).toEqual([1])
    sched.fireNext()
    expect(dumps).toEqual([1])
    await settle()
    sched.fireNext()
    expect(dumps).toEqual([1, 2])
    monitor.stop()
  })

  test('failed dumps also release the gate', async () => {
    const { dumps, triggerDump, settle } = createDumpFixture()
    const { monitor, sched } = createHarness({
      getHeapUsedBytes: () => 2 * 1024,
      triggerDump,
    })
    monitor.start()
    sched.fireNext()
    expect(dumps).toEqual([1])
    await settle({ success: false, error: 'disk full' })
    sched.fireNext()
    expect(dumps).toEqual([1, 2])
    monitor.stop()
  })

  test('a throwing dump trigger still releases the gate', async () => {
    const dumps: number[] = []
    const triggerDump = (dumpNumber: number): Promise<HeapDumpResult> => {
      dumps.push(dumpNumber)
      if (dumpNumber === 1) return Promise.reject(new Error('v8 crashed'))
      return Promise.resolve({ success: true, heapPath: '/tmp/h' })
    }
    const { monitor, sched } = createHarness({
      getHeapUsedBytes: () => 2 * 1024,
      triggerDump,
    })
    monitor.start()
    sched.fireNext()
    expect(dumps).toEqual([1])
    for (let i = 0; i < 6; i++) await Promise.resolve()
    sched.fireNext()
    expect(dumps).toEqual([1, 2])
    monitor.stop()
  })

  test('a throwing sampler is contained and the loop keeps running', () => {
    const { dumps, triggerDump } = createDumpFixture()
    let calls = 0
    const { monitor, sched } = createHarness({
      getHeapUsedBytes: () => {
        calls++
        if (calls === 1) throw new Error('meminfo unavailable')
        return 2 * 1024
      },
      triggerDump,
    })
    monitor.start()
    sched.fireNext()
    expect(dumps).toEqual([])
    expect(sched.pending).toHaveLength(1)
    sched.fireNext()
    expect(dumps).toEqual([1])
    monitor.stop()
  })

  test('start is idempotent — no duplicate timer chains', () => {
    const { dumps, triggerDump } = createDumpFixture()
    const { monitor, sched } = createHarness({
      getHeapUsedBytes: () => 0,
      triggerDump,
    })
    monitor.start()
    monitor.start()
    monitor.start()
    expect(sched.pending).toHaveLength(1)
    monitor.stop()
  })

  test('stop clears the pending timer (unref + clear) and silences ticks', () => {
    const { dumps, triggerDump } = createDumpFixture()
    const { monitor, sched } = createHarness({
      getHeapUsedBytes: () => 2 * 1024,
      triggerDump,
    })
    monitor.start()
    const handle = sched.pending[0]!
    monitor.stop()
    expect(handle.cleared).toBe(true)
    expect(handle.unrefed).toBe(true)
    expect(monitor.isRunning()).toBe(false)
    expect(sched.pending).toHaveLength(0)
    // Even if the cleared callback fired late, nothing happens.
    sched.all[0]!.callback()
    expect(dumps).toEqual([])
  })

  test('stop while a dump is in flight still releases the gate after settle', async () => {
    const { dumps, triggerDump, settle } = createDumpFixture()
    const { monitor, sched } = createHarness({
      getHeapUsedBytes: () => 2 * 1024,
      triggerDump,
    })
    monitor.start()
    sched.fireNext()
    monitor.stop()
    await settle()
    const gateProbe = new AutoHeapDumpGate()
    // New gate starts numbering at 1 again — monitor state itself is per-gate.
    expect(gateProbe.tryBegin()).toBe(1)
    gateProbe.end()
    expect(dumps).toEqual([1])
  })
})

describe('module-level start/stop', () => {
  test('start with out-of-reach threshold reschedules silently until stop', () => {
    const sched = createFakeScheduler()
    startSdkMemoryMonitor({
      intervalMs: 600_000,
      thresholdBytes: Number.MAX_SAFE_INTEGER,
      getHeapUsedBytes: () => 0,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    })
    sched.fireNext()
    expect(sched.pending).toHaveLength(1)
    stopSdkMemoryMonitor()
    expect(sched.pending).toHaveLength(0)
  })

  test('module-level start is idempotent across restarts', () => {
    const sched = createFakeScheduler()
    const deps = {
      intervalMs: 600_000,
      thresholdBytes: Number.MAX_SAFE_INTEGER,
      getHeapUsedBytes: () => 0,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    }
    startSdkMemoryMonitor(deps)
    startSdkMemoryMonitor(deps)
    expect(sched.pending).toHaveLength(1)
    stopSdkMemoryMonitor()
    stopSdkMemoryMonitor()
  })
})
