import { describe, expect, test } from 'bun:test'
import { FpsTracker, type FpsMetrics } from '../fpsTracker'

const RING_CAPACITY = 4096
const FRAME_INTERVAL_MS = 16.7

// Reference implementation kept verbatim from the pre-ring sorted-array
// version so the histogram rewrite can be proven to agree on small samples.
function referenceMetrics(
  frameDurations: number[],
  totalTimeMs: number,
): FpsMetrics {
  const totalFrames = frameDurations.length
  const averageFps = totalFrames / (totalTimeMs / 1000)

  const sorted = frameDurations.slice().sort((a, b) => b - a)
  const p99Index = Math.max(0, Math.ceil(sorted.length * 0.01) - 1)
  const p99FrameTimeMs = sorted[p99Index]
  const low1PctFps = p99FrameTimeMs > 0 ? 1000 / p99FrameTimeMs : 0

  return {
    averageFps: Math.round(averageFps * 100) / 100,
    low1PctFps: Math.round(low1PctFps * 100) / 100,
  }
}

// Deterministic wall clock so averageFps is assertable; the tracker stores
// firstRenderTime/lastRenderTime from these calls, so the elapsed-time
// helper reproduces the exact same arithmetic (bit-identical doubles).
function useFakeFrameClock() {
  const realNow = performance.now
  let calls = 0
  performance.now = () => {
    calls++
    return 10_000 + FRAME_INTERVAL_MS * calls
  }
  return {
    // Mirrors tracker arithmetic: (10_000 + W*N) - (10_000 + W*1)
    wallTimeMsFor(framesRecorded: number): number {
      return (
        10_000 +
        FRAME_INTERVAL_MS * framesRecorded -
        (10_000 + FRAME_INTERVAL_MS)
      )
    },
    restore: () => {
      performance.now = realNow
    },
  }
}

describe('FpsTracker', () => {
  test('returns undefined before any frame is recorded', () => {
    const tracker = new FpsTracker()
    expect(tracker.getMetrics()).toBeUndefined()
  })

  test('retained frames stay capped after sustained recording', () => {
    const tracker = new FpsTracker()
    for (let i = 0; i < 10_000; i++) {
      tracker.record(8 + (i % 7))
    }
    const stats = tracker.getInternalStats()
    expect(stats.capacity).toBe(RING_CAPACITY)
    expect(stats.retainedFrames).toBe(RING_CAPACITY)
    expect(stats.totalFramesRecorded).toBe(10_000)
  })

  test('small samples match the sorted-array reference exactly', () => {
    const clock = useFakeFrameClock()
    try {
      const tracker = new FpsTracker()
      // One value per 1ms bucket (unique floors, all < 100ms) so the bucket
      // mean equals the exact sample; duplicated values keep means exact too.
      const base = Array.from({ length: 100 }, (_, i) => i + 0.5)
      const durations = [...base, ...base] // n=200 → p99 lands on 99.5

      for (const duration of durations) tracker.record(duration)

      const metrics = tracker.getMetrics()
      expect(metrics).toEqual(
        referenceMetrics(durations, clock.wallTimeMsFor(durations.length)),
      )
    } finally {
      clock.restore()
    }
  })

  test('overflow outlier matches the reference exactly', () => {
    const clock = useFakeFrameClock()
    try {
      const tracker = new FpsTracker()
      const durations = [200, ...Array.from({ length: 99 }, () => 16)]
      for (const duration of durations) tracker.record(duration)

      const metrics = tracker.getMetrics()
      expect(metrics).toEqual(
        referenceMetrics(durations, clock.wallTimeMsFor(durations.length)),
      )
      expect(metrics?.low1PctFps).toBe(5) // 1000/200
    } finally {
      clock.restore()
    }
  })

  test('getMetrics stays exact past wrap without reallocation', () => {
    const clock = useFakeFrameClock()
    try {
      const tracker = new FpsTracker()
      for (let i = 0; i < 5000; i++) tracker.record(8)
      const first = tracker.getMetrics()

      for (let i = 0; i < 5000; i++) tracker.record(8)
      const second = tracker.getMetrics()
      const repeat = tracker.getMetrics()

      expect(first).toBeDefined()
      expect(second).toEqual(repeat)
      // 1000/8 = exact p99 value for homogeneous 8ms frames.
      expect(second?.low1PctFps).toBe(125)
      expect(Number.isFinite(second?.averageFps)).toBe(true)
      expect(tracker.getInternalStats().retainedFrames).toBe(RING_CAPACITY)
    } finally {
      clock.restore()
    }
  })
})
