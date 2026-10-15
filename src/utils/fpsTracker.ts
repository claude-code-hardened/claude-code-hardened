/**
 * FPS tracker for the render loop.
 *
 * Memory model: frame durations go into a fixed 4096-slot ring backed by a
 * Float64Array and an incremental 1ms histogram. The pre-ring implementation
 * pushed every duration into an unbounded array and did slice().sort() over
 * the full history on each getMetrics() call — a deterministic leak on long
 * sessions plus an O(n log n) hitch every time metrics were read. Both costs
 * are now constant: memory caps at the ring + 101 buckets, reads are
 * O(buckets). The p99 source is therefore the last 4096 frames (recent
 * window) instead of all frames ever, which is also the more actionable
 * signal for a live display.
 */

export type FpsMetrics = {
  averageFps: number
  low1PctFps: number
}

const RING_CAPACITY = 4096
const HISTOGRAM_BUCKET_WIDTH_MS = 1
const HISTOGRAM_RANGE_MS = 100
// [0, HISTOGRAM_RANGE_MS) in HISTOGRAM_BUCKET_WIDTH_MS buckets plus one
// overflow bucket for durations >= HISTOGRAM_RANGE_MS at the last index.
const HISTOGRAM_BUCKETS = HISTOGRAM_RANGE_MS / HISTOGRAM_BUCKET_WIDTH_MS + 1
const OVERFLOW_BUCKET = HISTOGRAM_BUCKETS - 1

function histogramBucket(durationMs: number): number {
  if (Number.isNaN(durationMs) || durationMs >= HISTOGRAM_RANGE_MS) {
    return OVERFLOW_BUCKET
  }
  if (durationMs < 0) return 0
  return Math.floor(durationMs / HISTOGRAM_BUCKET_WIDTH_MS)
}

export class FpsTracker {
  private ring = new Float64Array(RING_CAPACITY)
  private ringHead = 0
  private ringSize = 0
  // All frames ever recorded, kept as a scalar so averageFps preserves the
  // original "session-wide fps" meaning; only the p99 source is windowed.
  private totalFrames = 0
  private bucketCounts = new Int32Array(HISTOGRAM_BUCKETS)
  private bucketSums = new Float64Array(HISTOGRAM_BUCKETS)
  private firstRenderTime: number | undefined
  private lastRenderTime: number | undefined

  record(durationMs: number): void {
    // Clamp non-finite durations (NaN/±∞) to the overflow-bucket boundary as
    // finite mass: they belong in the overflow bucket anyway, and this keeps
    // the bucket's running sum finite (a single NaN would poison it forever).
    if (!Number.isFinite(durationMs)) {
      durationMs = HISTOGRAM_RANGE_MS
    }
    const now = performance.now()
    if (this.firstRenderTime === undefined) {
      this.firstRenderTime = now
    }
    this.lastRenderTime = now

    if (this.ringSize === RING_CAPACITY) {
      // Overwrite the oldest slot and unwind its histogram contribution so
      // bucket counts always mirror exactly the retained window.
      const evicted = this.ring[this.ringHead]
      const evictedBucket = histogramBucket(evicted)
      this.bucketCounts[evictedBucket]--
      this.bucketSums[evictedBucket] -= evicted
    } else {
      this.ringSize++
    }
    this.ring[this.ringHead] = durationMs
    this.ringHead = (this.ringHead + 1) % RING_CAPACITY
    this.totalFrames++

    const bucket = histogramBucket(durationMs)
    this.bucketCounts[bucket]++
    this.bucketSums[bucket] += durationMs
  }

  getMetrics(): FpsMetrics | undefined {
    if (
      this.totalFrames === 0 ||
      this.firstRenderTime === undefined ||
      this.lastRenderTime === undefined
    ) {
      return undefined
    }

    const totalTimeMs = this.lastRenderTime - this.firstRenderTime
    if (totalTimeMs <= 0) {
      return undefined
    }

    const totalFrames = this.totalFrames
    const averageFps = totalFrames / (totalTimeMs / 1000)

    // low1PctFps stays a histogram-bucket approximation of the exact p99
    // (in-bucket mean as the estimate): consumers only need a stable trend
    // signal per render frame, and the exact value would reintroduce the
    // O(n log n) copy+sort this design removes.
    const p99FrameTimeMs = this.topPercentileFrameTime(0.01)
    const low1PctFps = p99FrameTimeMs > 0 ? 1000 / p99FrameTimeMs : 0

    return {
      averageFps: Math.round(averageFps * 100) / 100,
      low1PctFps: Math.round(low1PctFps * 100) / 100,
    }
  }

  /**
   * k-th largest retained frame time via the incremental histogram,
   * k = ceil(n * percentile) — matches the legacy sort-based semantics
   * (percentile 0.01 → the slowest ceil(0.01·n) frames).
   * O(HISTOGRAM_BUCKETS), no allocation.
   */
  private topPercentileFrameTime(percentile: number): number {
    const k = Math.max(1, Math.ceil(this.ringSize * percentile))
    let cumulative = 0
    for (let bucket = OVERFLOW_BUCKET; bucket >= 0; bucket--) {
      const count = this.bucketCounts[bucket]
      if (count === 0) continue
      cumulative += count
      if (cumulative >= k) {
        return this.bucketSums[bucket] / count
      }
    }
    return 0
  }

  /**
   * Internal diagnostics for leak-regression tests (not part of the public
   * FpsMetrics API): retained window size vs the hard capacity.
   */
  getInternalStats(): {
    retainedFrames: number
    capacity: number
    totalFramesRecorded: number
  } {
    return {
      retainedFrames: this.ringSize,
      capacity: RING_CAPACITY,
      totalFramesRecorded: this.totalFrames,
    }
  }
}
