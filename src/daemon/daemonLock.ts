import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

/**
 * daemon.lock protocol — 1:1 with the official supervisor's handshake
 * (chunk-e88tq28v):
 *
 *   lock JSON   { pid, startedAt, origin: 'transient' | 'service' }
 *   acquire     pid alive + signalable by this user → held (displaced)
 *               pid dead / not signalable (stale)   → replace the lock
 *   yield       transient yields to service origin; refusal is reported as
 *               "existing daemon refused to yield (it reports origin!=transient)"
 *   polling     displaced supervisors keep probing the lock and exit with
 *               cause 'displaced' / 'yield'
 */

export type LockOrigin = 'transient' | 'service'

export interface DaemonLock {
  pid: number
  startedAt: string
  origin: LockOrigin
}

export type AcquireResult =
  | { status: 'acquired' }
  | { status: 'held'; holder: DaemonLock }
  | { status: 'replaced-stale'; previous: DaemonLock }

export function daemonLockPath(): string {
  return join(homedir(), '.claude', 'daemon', 'daemon.lock')
}

export function readLock(): DaemonLock | null {
  try {
    const raw = readFileSync(daemonLockPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<DaemonLock>
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'string' ||
      (parsed.origin !== 'transient' && parsed.origin !== 'service')
    ) {
      return null
    }
    return parsed as DaemonLock
  } catch {
    return null
  }
}

export function writeLock(origin: LockOrigin): void {
  const p = daemonLockPath()
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  const lock: DaemonLock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    origin,
  }
  writeFileSync(p, JSON.stringify(lock, null, 2), { mode: 0o600 })
}

export function clearLock(): void {
  try {
    unlinkSync(daemonLockPath())
  } catch {
    // absent already
  }
}

/**
 * Whether this user can signal the pid (upstream's signalability probe:
 * same-uid check keeps us from clobbering another user's live daemon).
 */
export function signalableByCurrentUser(pid: number): boolean {
  if (process.platform === 'win32') return true
  try {
    const stat = readFileSync(`/proc/${pid}/status`, 'utf8')
    const m = stat.match(/^Uid:\s+\d+\s+(\d+)/m)
    const uid = process.getuid?.()
    return m ? Number(m[1]) === uid : uid === 0
  } catch {
    return false
  }
}

/**
 * Upstream acquire semantics:
 *   - no lock / lock pid dead / not signalable → stale → replace
 *   - lock pid alive and signalable → held (we are displaced)
 */
export function acquireLock(origin: LockOrigin): AcquireResult {
  const existing = readLock()
  if (!existing) {
    writeLock(origin)
    return { status: 'acquired' }
  }
  let alive = false
  try {
    process.kill(existing.pid, 0)
    alive = true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') alive = false
    else {
      // EPERM: the pid belongs to someone else — upstream treats an
      // unsignalable pid as stale ("that pid now belongs to another
      // process") only when the process is dead; a live foreign pid
      // still holds the lock but cannot be signalled by us.
      alive = existsSync(`/proc/${existing.pid}`)
    }
  }
  if (alive && signalableByCurrentUser(existing.pid)) {
    return { status: 'held', holder: existing }
  }
  if (alive && !signalableByCurrentUser(existing.pid)) {
    // live but foreign: upstream replaces only when the lock "predates
    // this boot" or the pid was recycled; conservatively treat as held.
    return { status: 'held', holder: existing }
  }
  writeLock(origin)
  return { status: 'replaced-stale', previous: existing }
}

/** Whether the holder is a transient daemon that we may ask to yield. */
export function canAskToYield(holder: DaemonLock): boolean {
  return holder.origin === 'transient'
}

export const YIELD_REFUSAL_MESSAGE =
  'existing daemon refused to yield (it reports origin!=transient)'
