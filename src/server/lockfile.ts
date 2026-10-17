import { mkdir, open, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'

import { jsonStringify } from '../utils/slowOperations.js'

/**
 * Server lock file ("split-brain" guard; official chunk-6bdfd8nk keeps a
 * single `claude server` per config-dir — a second start must report
 * "already running (pid X)" and exit 1 instead of racing on the same
 * workspace, which manifests downstream as connection timeouts).
 *
 * The lock is a JSON document at $CLAUDE_CONFIG_DIR (default ~/.claude)/
 * server.lock recording pid/port/host/httpUrl/startedAt. Liveness is probed
 * with kill(pid, 0) plus an optional /health cross-check (PID-reuse guard).
 */

export interface ServerLockInfo {
  pid: number
  port: number
  host: string
  httpUrl: string
  startedAt: number
}

const LOCK_FILE_NAME = 'server.lock'

/** Absolute path of the server lock file. Exported for tests. */
export function serverLockPath(): string {
  const base =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  return path.join(base, LOCK_FILE_NAME)
}

/** Ensure the lock file's parent directory exists. */
async function ensureLockDir(): Promise<void> {
  await mkdir(path.dirname(serverLockPath()), { recursive: true })
}

/**
 * Persist the lock. Plain write suffices for single-instance semantics: the
 * probe below treats a corrupt/partial read as a stale lock and removes it.
 * TODO(下一代): O_EXCL reserve file so two concurrent `claude server` boots
 * cannot both claim the lock (official does this in its lock create path).
 */
export const writeServerLock: (info: ServerLockInfo) => Promise<void> =
  async info => {
    await ensureLockDir()
    // O_EXCL ('wx'): lock creation is the split-brain reservation itself —
    // two concurrent `claude server` starts must not both succeed the
    // write; the loser surfaces EEXIST as "already running".
    const handle = await open(serverLockPath(), 'wx')
    try {
      await handle.writeFile(jsonStringify(info), 'utf8')
    } finally {
      await handle.close()
    }
  }

/** Remove the lock file (ignore "not found"). */
export const removeServerLock: () => Promise<void> = async () => {
  await rm(serverLockPath(), { force: true })
}

/**
 * kill(pid, 0) liveness probe. EPERM means the process exists but is owned by
 * another user — still counts as alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isValidLockInfo(value: unknown): value is ServerLockInfo {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.pid === 'number' &&
    typeof v.port === 'number' &&
    typeof v.host === 'string' &&
    typeof v.httpUrl === 'string' &&
    typeof v.startedAt === 'number'
  )
}

/**
 * Probe for a running server:
 *  1. No / unreadable lock file → null.
 *  2. Corrupt lock → remove it, return null (stale garbage).
 *  3. Dead pid (ENOENT from kill(0)) → remove the stale lock, return null.
 *  4. Alive pid → cross-check GET <httpUrl>/health when the lock points at a
 *     HTTP URL. If /health reports a different live pid (the split-brain
 *     case: locked pid was reused while the real server moved on), report the
 *     *live* server info so the caller refuses to start either way.
 *  5. Unix-socket locks (httpUrl `unix:...`) rely on the pid probe alone.
 *
 * Conservative by design: an alive pid we cannot disprove is reported as
 * "already running" — a false positive beats two servers bound to the same
 * workspace (the connection-timeout chaos of previous generations).
 */
export const probeRunningServer: () => Promise<ServerLockInfo | null> =
  async () => {
    let raw: string
    try {
      raw = await readFile(serverLockPath(), 'utf8')
    } catch {
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      await removeServerLock()
      return null
    }
    if (!isValidLockInfo(parsed)) {
      await removeServerLock()
      return null
    }
    const lock = parsed

    if (!isPidAlive(lock.pid)) {
      await removeServerLock()
      return null
    }

    if (
      lock.httpUrl.startsWith('http://') ||
      lock.httpUrl.startsWith('https://')
    ) {
      try {
        const resp = await fetch(`${lock.httpUrl}/health`, {
          signal: AbortSignal.timeout(1500),
        })
        if (resp.ok) {
          const health = (await resp.json()) as { pid?: number; port?: number }
          if (
            typeof health.pid === 'number' &&
            health.pid !== lock.pid &&
            isPidAlive(health.pid)
          ) {
            // Live listener is not the locked pid: prefer the live server.
            return {
              ...lock,
              pid: health.pid,
              ...(typeof health.port === 'number' && health.port > 0
                ? { port: health.port }
                : {}),
            }
          }
        }
      } catch {
        // /health unreachable — pid is alive, keep the conservative answer.
      }
    }

    return lock
  }
