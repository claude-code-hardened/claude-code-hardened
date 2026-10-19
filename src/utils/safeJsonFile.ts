/**
 * Shared JSON store helpers for local marker/record files under the Claude
 * config home (design-session.json, loops.json, aliases.json, ...).
 *
 * Guarantees the individual stores previously lacked:
 *  1. Atomic writes — every save goes through write-tmp + rename so a crash
 *     mid-write can never leave a truncated/partial file behind.
 *  2. Corruption refusal — a file that no longer parses (or no longer matches
 *     its expected shape) is never silently treated as empty and overwritten
 *     by the next read-modify-write. Instead it is quarantined to a
 *     `<name>.corrupt-<timestamp>` backup (renamed, never copy+delete) and a
 *     StoreCorruptError is thrown after logging, so data loss stays visible
 *     and recoverable instead of silent.
 *  3. Locking for read-modify-write — `withStoreLock` takes an advisory
 *     `<name>.lock` (O_EXCL create, stale-seizure after a timeout) so two
 *     processes racing a create/update cannot lose each other's write in the
 *     read→write window. Advisory only: readers without the lock still see
 *     the last fully-renamed state, never a partial file.
 */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { logError } from './log.js'

/** Raised when a store file is unreadable; the original was moved to `backupPath`. */
export class StoreCorruptError extends Error {
  readonly backupPath: string

  constructor(path: string, backupPath: string, reason: string) {
    super(
      `${path} is corrupt (${reason}); the original file was moved aside to ${backupPath} and was NOT overwritten.`,
    )
    this.name = 'StoreCorruptError'
    this.backupPath = backupPath
  }
}

/**
 * Number of `.corrupt-*` backups kept per store file before the oldest is
 * pruned. Small on purpose — quarantine is a safety net, not an archive.
 */
const QUARANTINE_RETENTION_LIMIT = 10

/** Time (ms) between lock-acquire retries. */
const LOCK_RETRY_MS = 5

/**
 * A `<name>.lock` older than this is considered abandoned (crashed holder,
 * which leaves no chance to release it) and is seized by the next writer.
 * Held locks are not refreshed — critical sections here are single-digit-ms,
 * so this is comfortably above any legitimate hold time.
 */
export const STORE_LOCK_STALE_MS = 10_000

/** Overall give-up time when a live (non-stale) lock never frees. */
export const STORE_LOCK_TIMEOUT_MS = 15_000

function tmpPathFor(path: string): string {
  return `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
}

function quarantineBackupsFor(path: string): string[] {
  const dir = dirname(path)
  const prefix = `${basename(path)}.corrupt-`
  try {
    return readdirSync(dir)
      .filter(name => name.startsWith(prefix))
      .sort()
  } catch {
    // The directory vanished between the rename and the prune — nothing to do.
    return []
  }
}

/**
 * Move a corrupt store file aside so the next call starts clean while the
 * raw bytes stay recoverable. Returns the backup path.
 *
 * Single-rename official form (decompiled 0004-chunk-zrkp23rq/
 * module-005-uncategorized.js:3861, deviceKeyStore.read): the corrupt file is
 * RENAMED (never copy+unlink, which leaves a window where the original no
 * longer exists but the backup does not yet) to
 * `<file>.corrupt-<Date.now()>-<pid>-<3-byte-hex>` — milliseconds + pid +
 * random suffix so two processes racing the same corrupt file cannot collide.
 * A vanished source (ENOENT — a concurrent quarantine already moved it) is
 * tolerated: the computed backup path is returned and the caller's
 * StoreCorruptError still reports it.
 *
 * Retention: more than QUARANTINE_RETENTION_LIMIT backups beside the same
 * store file → oldest (by mtime) are unlinked (best effort).
 */
export function quarantineCorruptFile(path: string): string {
  const backupPath =
    `${path}.corrupt-${Date.now()}-${process.pid}-` +
    randomBytes(3).toString('hex')
  try {
    renameSync(path, backupPath)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // A concurrent quarantine already renamed the original away (or it was
      // removed externally). Nothing left to preserve — return the intended
      // backup path so the caller's error message stays accurate.
      return backupPath
    }
    throw e
  }

  // Retention cap: drop backups beyond the limit, oldest first. mtime-sorted
  // with a name-tiebreak; unlink failures are ignored (best-effort prune).
  const backups = quarantineBackupsFor(path)
  if (backups.length > QUARANTINE_RETENTION_LIMIT) {
    const dir = dirname(path)
    const withMtime = backups
      .map(name => {
        try {
          return { name, mtimeMs: statSync(`${dir}/${name}`).mtimeMs }
        } catch {
          return { name, mtimeMs: 0 }
        }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    const excess = withMtime.slice(
      0,
      withMtime.length - QUARANTINE_RETENTION_LIMIT,
    )
    for (const { name } of excess) {
      try {
        unlinkSync(`${dir}/${name}`)
      } catch {
        // best effort — a concurrent prune may have removed it already
      }
    }
  }
  return backupPath
}

/**
 * Advisory lock around a read-modify-write against one store file.
 *
 * Acquires `<name>.lock` by exclusive create (`wx` = O_CREAT|O_EXCL). On
 * EEXIST the lock's mtime is checked: older than STORE_LOCK_STALE_MS → the
 * lock is seized (unlinked and re-created); otherwise the caller sleeps
 * LOCK_RETRY_MS and retries until STORE_LOCK_TIMEOUT_MS, then throws rather
 * than racing a stuck writer. The lock is released (unlink, ENOENT-tolerant)
 * even when `fn` throws. Non-reentrant by design — callers must not nest
 * withStoreLock on the same path.
 */
export function withStoreLock<T>(
  path: string,
  fn: () => T,
  options: { timeoutMs?: number; staleMs?: number } = {},
): T {
  const lockPath = `${path}.lock`
  const timeoutMs = options.timeoutMs ?? STORE_LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? STORE_LOCK_STALE_MS
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let fd: number
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out acquiring store lock ${lockPath} after ${timeoutMs}ms — ` +
          'another writer appears stuck; refusing to risk a lost update',
      )
    }
    try {
      fd = openSync(lockPath, 'wx')
      break
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e
      let holderMtimeMs: number | undefined
      try {
        holderMtimeMs = statSync(lockPath).mtimeMs
      } catch {
        // The holder released between create and stat — retry immediately.
        continue
      }
      if (Date.now() - holderMtimeMs > staleMs) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Another waiter broke the stale lock first — fall through to retry.
        }
      } else {
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          LOCK_RETRY_MS,
        )
      }
    }
  }
  try {
    // Advisory content for human debugging: who holds it and since when.
    try {
      writeSync(fd, `${process.pid} ${new Date().toISOString()}`)
    } catch {
      // The lock's existence is the contract, its content is only a hint.
    }
    return fn()
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore — release below is the signal that matters
    }
    try {
      unlinkSync(lockPath)
    } catch {
      // ignore — ENOENT means a stale-seizure already reclaimed it
    }
  }
}

/**
 * Atomic JSON write: serialize, write to a tmp file in the same directory,
 * then rename over the target. Readers see either the old or the new file,
 * never a partial write.
 */
export function writeJsonFileAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = tmpPathFor(path)
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (e: unknown) {
    // Best effort clean-up so repeated failures don't litter tmp files.
    try {
      unlinkSync(tmp)
    } catch {
      // ignore — the rename failure is the signal that matters
    }
    throw e
  }
}

/**
 * Read a JSON store file with corruption refusal.
 *
 * - Missing file → null (a genuinely fresh store).
 * - Parses (any JSON value) → the parsed value; the caller validates shape.
 * - Unparseable → quarantined to a .corrupt-<ts> backup and StoreCorruptError
 *   is thrown (the read-modify-write caller must not treat this as empty).
 *   The quarantine is logged (logError) here so every caller gets the data
 *   loss on the record without repeating the plumbing.
 */
export function readJsonFileStrict(path: string): unknown | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw e
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    const backupPath = quarantineCorruptFile(path)
    logError(new StoreCorruptError(path, backupPath, 'not valid JSON'))
    throw new StoreCorruptError(path, backupPath, 'not valid JSON')
  }
}

/**
 * Quarantine + log + throw for files that parse as JSON but fail their
 * expected shape check — same data-loss risk as unparseable files, same
 * refusal.
 */
export function rejectCorruptJsonFile(path: string, reason: string): never {
  const backupPath = quarantineCorruptFile(path)
  logError(new StoreCorruptError(path, backupPath, reason))
  throw new StoreCorruptError(path, backupPath, reason)
}
