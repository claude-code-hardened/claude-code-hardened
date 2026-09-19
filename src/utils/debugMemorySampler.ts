import { isDebugMode, logForDebugging } from './debug.js'

// Long-session memory forensics. Samples every second but only WRITES when a
// record is broken (peak watermark) or the message count changes — a 10s
// cadence provably misses spikes (observed 300MB+ swings between samples,
// user-reported 1GB vs sampled 792MB). The watermark guarantees the true
// maximum RSS/heap lands in the log, while message-count changes keep the
// growth timeline correlatable. Cost: one process.memoryUsage() per second,
// zero writes unless something actually grew.
const MEMORY_SAMPLE_INTERVAL_MS = 1_000

export function startDebugMemorySampler(getMessageCount: () => number): void {
  if (!isDebugMode()) return
  let lastCount = -1
  let peakRss = 0
  let peakHeap = 0
  const tick = (): void => {
    const mem = process.memoryUsage()
    const count = getMessageCount()
    const rssMb = mem.rss / 1048576
    const heapMb = mem.heapUsed / 1048576
    const isPeak = rssMb > peakRss || heapMb > peakHeap
    if (isPeak || count !== lastCount) {
      if (rssMb > peakRss) peakRss = rssMb
      if (heapMb > peakHeap) peakHeap = heapMb
      const delta = lastCount === -1 ? 0 : count - lastCount
      logForDebugging(
        `[mem] rss=${rssMb.toFixed(1)}MB heap=${heapMb.toFixed(1)}MB msgs=${count}${delta !== 0 ? ` (${delta >= 0 ? '+' : ''}${delta})` : ''} peakRss=${peakRss.toFixed(1)}MB peakHeap=${peakHeap.toFixed(1)}MB`,
      )
    }
    lastCount = count
  }
  tick()
  setInterval(tick, MEMORY_SAMPLE_INTERVAL_MS)
}
