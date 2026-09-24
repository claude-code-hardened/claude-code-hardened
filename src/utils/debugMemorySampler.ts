import { isDebugMode, logForDebugging } from './debug.js'

// Long-session memory forensics. Periodically samples RSS/heap plus the live
// message count so a 400MB→1GB jump can be aligned with whatever happened in
// the same window (message bursts, streaming responses, compaction). The
// sample includes the delta since the previous tick — a burst shows up as
// "(+N)" right next to the RSS jump, which is exactly the evidence needed to
// attribute growth to the message graph vs. something else.
const MEMORY_SAMPLE_INTERVAL_MS = 10_000

export function startDebugMemorySampler(getMessageCount: () => number): void {
  if (!isDebugMode()) return
  let lastCount = -1
  const tick = (): void => {
    const mem = process.memoryUsage()
    const count = getMessageCount()
    const delta = lastCount === -1 ? 0 : count - lastCount
    logForDebugging(
      `[mem] rss=${(mem.rss / 1048576).toFixed(1)}MB heap=${(mem.heapUsed / 1048576).toFixed(1)}MB msgs=${count}${delta !== 0 ? ` (${delta >= 0 ? '+' : ''}${delta})` : ''}`,
    )
    lastCount = count
  }
  tick()
  const timer = setInterval(tick, MEMORY_SAMPLE_INTERVAL_MS)
  // Keep the process reference only for as long as the sampler lives; the
  // REPL is a long-lived process so no unref games — clear on nothing, the
  // timer dies with the process.
  void timer
}
