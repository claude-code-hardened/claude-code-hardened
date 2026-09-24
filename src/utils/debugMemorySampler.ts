import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getSessionId } from 'src/bootstrap/state.js'
import {
  isDebugMode,
  logForDebugging,
} from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { jsonStringify } from './slowOperations.js'

// Long-session memory forensics. Always-on (not DEBUG-gated): samples
// RSS/heap/external plus registered module holders on an interval, writing
// JSONL to ~/.claude/debug/memory-<sessionId>.jsonl so a 400MB→2.8GB climb
// can be attributed after the fact. Message-count deltas already flag idle
// vs. active windows; use markMemory() at turn/compact boundaries for exact
// attribution. When RSS crosses the snapshot threshold (default 1.5 GB,
// CCB_HEAP_SNAPSHOT_MB) a .heapsnapshot is dumped once per session for
// Chrome DevTools retention-chain analysis.
const SAMPLE_INTERVAL_MS_DEBUG = 10_000
const SAMPLE_INTERVAL_MS = 60_000
const DEFAULT_SNAPSHOT_THRESHOLD_MB = 1536

type MemoryHolder = { name: string; get: () => number }

const holders: MemoryHolder[] = []
let logPath: string | null = null
let snapshotDumped = false

export function registerMemoryHolder(
  name: string,
  get: () => number,
): void {
  holders.push({ name, get })
}

export function markMemory(label: string): void {
  if (!logPath) return
  writeSample({ event: 'mark', label })
}

function sampleIntervalMs(): number {
  return isDebugMode() ? SAMPLE_INTERVAL_MS_DEBUG : SAMPLE_INTERVAL_MS
}

function snapshotThresholdMb(): number {
  const raw = Number(process.env.CCB_HEAP_SNAPSHOT_MB)
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_SNAPSHOT_THRESHOLD_MB
}

function ensureLogPath(): string {
  if (!logPath) {
    const sessionId = getSessionIdSafe()
    const dir = debugLogsDir()
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, `memory-${sessionId}.jsonl`)
  }
  return logPath
}

function debugLogsDir(): string {
  if (process.env.CLAUDE_CODE_DEBUG_LOGS_DIR) {
    return resolve(process.env.CLAUDE_CODE_DEBUG_LOGS_DIR)
  }
  return join(getClaudeConfigHomeDirSafe(), 'debug')
}

function getSessionIdSafe(): string {
  try {
    return getSessionId()
  } catch {
    return 'unknown'
  }
}

function getClaudeConfigHomeDirSafe(): string {
  try {
    return getClaudeConfigHomeDir()
  } catch {
    return join(homedir(), '.claude')
  }
}

function writeSample(extra: Record<string, unknown>): void {
  const mem = process.memoryUsage()
  const record = {
    ts: new Date().toISOString(),
    event: 'sample',
    rssMb: round(mem.rss / 1048576),
    heapUsedMb: round(mem.heapUsed / 1048576),
    externalMb: round(mem.external / 1048576),
    arrayBuffersMb: round((mem.arrayBuffers ?? 0) / 1048576),
    ...extra,
  }
  try {
    appendFileSync(ensureLogPath(), `${jsonStringify(record)}\n`)
  } catch {
    // The tracker must never take the session down over I/O errors.
  }
  maybeDumpHeapSnapshot(record.rssMb)
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

function maybeDumpHeapSnapshot(rssMb: number): void {
  if (snapshotDumped || rssMb < snapshotThresholdMb()) return
  snapshotDumped = true
  try {
    const dir = dirname(ensureLogPath())
    const path = join(
      dir,
      `heap-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.round(rssMb)}MB.heapsnapshot`,
    )
    writeFileSync(path, String(Bun.generateHeapSnapshot()))
    logForDebugging(
      `[mem] RSS ${rssMb}MB over threshold — heap snapshot written: ${path}`,
    )
    appendFileSync(
      ensureLogPath(),
      `${jsonStringify({
        ts: new Date().toISOString(),
        event: 'heap_snapshot',
        path,
        rssMb,
      })}\n`,
    )
  } catch {
    // Snapshot best-effort; the JSONL timeline continues regardless.
  }
}

export function startDebugMemorySampler(
  getMessageCount: () => number,
): void {
  let lastCount = -1
  const tick = (): void => {
    const count = getMessageCount()
    const delta = lastCount === -1 ? 0 : count - lastCount
    const active = delta !== 0
    const holderSamples: Record<string, number> = {}
    for (const h of holders) {
      try {
        holderSamples[h.name] = h.get()
      } catch {
        holderSamples[h.name] = -1
      }
    }
    writeSample({
      ...(active ? { msgDelta: delta } : {}),
      ...(Object.keys(holderSamples).length > 0
        ? { holders: holderSamples }
        : {}),
      msgs: count,
    })
    lastCount = count
  }
  tick()
  const timer = setInterval(tick, sampleIntervalMs())
  timer.unref?.()
}
