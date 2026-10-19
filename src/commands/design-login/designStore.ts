/**
 * W3 task #54 — design session local store. Shared by /design-login and
 * /design-revoke: the connection record lives at
 * <config home>/design-session.json so both commands (and any later design
 * surface) agree on one persistence point.
 *
 * Honesty note: the record is a local marker only. This build has no design
 * session transport (no OAuth/device flow, no cloud sync), so "connected"
 * means "a marker was written locally" — nothing more.
 */

import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  readJsonFileStrict,
  rejectCorruptJsonFile,
  writeJsonFileAtomic,
} from '../../utils/safeJsonFile.js'

export type DesignSessionStatus = 'connected' | 'revoked'

export interface DesignSessionRecord {
  status: DesignSessionStatus
  updatedAt: string
}

export function getDesignSessionPath(): string {
  return join(getClaudeConfigHomeDir(), 'design-session.json')
}

/**
 * Load the design session record. A corrupt file is quarantined to a
 * .corrupt-<ts> backup and StoreCorruptError is raised — a lost marker is
 * reported, never silently rewritten as "not connected".
 */
export function loadDesignSession(): DesignSessionRecord | null {
  const path = getDesignSessionPath()
  const parsed = readJsonFileStrict(path)
  if (parsed === null) return null
  const record = parsed as Partial<DesignSessionRecord> | null
  if (
    !record ||
    (record.status !== 'connected' && record.status !== 'revoked') ||
    typeof record.updatedAt !== 'string'
  ) {
    rejectCorruptJsonFile(path, 'not a design session record')
  }
  return record as DesignSessionRecord
}

export function writeDesignSession(status: DesignSessionStatus): void {
  const record: DesignSessionRecord = {
    status,
    updatedAt: new Date().toISOString(),
  }
  writeJsonFileAtomic(getDesignSessionPath(), record)
}

export function clearDesignSession(): void {
  writeDesignSession('revoked')
}
