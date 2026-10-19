/**
 * Shared JSON store helpers for local marker/record files under the Claude
 * config home (design-session.json, loops.json, aliases.json, ...).
 *
 * Two guarantees the individual stores previously lacked:
 *  1. Atomic writes — every save goes through write-tmp + rename so a crash
 *     mid-write can never leave a truncated/partial file behind.
 *  2. Corruption refusal — a file that no longer parses (or no longer matches
 *     its expected shape) is never silently treated as empty and overwritten
 *     by the next read-modify-write. Instead it is quarantined to a
 *     `<name>.corrupt-<timestamp>` backup and a StoreCorruptError is thrown,
 *     so data loss stays visible and recoverable instead of silent.
 */

import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** Raised when a store file is unreadable; the original is preserved at `backupPath`. */
export class StoreCorruptError extends Error {
  readonly backupPath: string

  constructor(path: string, backupPath: string, reason: string) {
    super(
      `${path} is corrupt (${reason}); the original file was preserved at ${backupPath} and was NOT overwritten.`,
    )
    this.name = 'StoreCorruptError'
    this.backupPath = backupPath
  }
}

function tmpPathFor(path: string): string {
  return `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
}

/**
 * Move a corrupt store file aside so the next call starts clean while the
 * raw bytes stay recoverable. Returns the backup path.
 */
export function quarantineCorruptFile(path: string): string {
  const backupPath = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(path, backupPath)
  unlinkSync(path)
  return backupPath
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
    throw new StoreCorruptError(path, backupPath, 'not valid JSON')
  }
}

/**
 * Quarantine + throw for files that parse as JSON but fail their expected
 * shape check — same data-loss risk as unparseable files, same refusal.
 */
export function rejectCorruptJsonFile(path: string, reason: string): never {
  const backupPath = quarantineCorruptFile(path)
  throw new StoreCorruptError(path, backupPath, reason)
}
