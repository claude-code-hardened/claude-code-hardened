/**
 * W4 (#55) — security environment read layer.
 *
 * Central, validated accessors for the security-sensitive env vars the
 * official build recognizes. Read-only by design: these never mutate
 * process.env, and nothing outside this module should reach for them by
 * string (keep the surface auditable).
 *
 * Recognized:
 *   CLAUDE_CODE_GATEWAY_TOKEN / CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR
 *   CLAUDE_CODE_BG_AUTH_SNAPSHOT_PATH
 *   CLAUDE_SECURESTORAGE_CONFIG_DIR
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { isAbsolute } from 'path'
import { logForDebugging } from '../debug.js'

function fdFromEnv(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 3) {
    logForDebugging(
      `[security] ignored invalid file descriptor value "${value}" (must be an integer >= 3)`,
    )
    return null
  }
  return n
}

/**
 * Gateway bearer token for enterprise gateway deployments.
 * Resolution order (official shape): literal env, then an open file
 * descriptor (secrets managers commonly hand one over); FD content wins
 * when both are present because it is the more deliberate choice.
 */
export function getGatewayToken(): string | null {
  const literal = process.env.CLAUDE_CODE_GATEWAY_TOKEN
  const fd = fdFromEnv(process.env.CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR)
  if (fd !== null) {
    try {
      const content = readFileSync(fd, 'utf8').trim()
      if (content !== '') return content
    } catch (error) {
      logForDebugging(
        `[security] gateway token FD ${fd} unreadable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return literal !== undefined && literal !== '' ? literal : null
}

/**
 * Background auth snapshot path — the file a detached/CLI login writes and
 * background sessions read. Must be absolute when set.
 */
export function getBgAuthSnapshotPath(): string | null {
  const p = process.env.CLAUDE_CODE_BG_AUTH_SNAPSHOT_PATH
  if (p === undefined || p === '') return null
  if (!isAbsolute(p)) {
    logForDebugging(
      `[security] ignoring relative BG auth snapshot path "${p}" (must be absolute)`,
    )
    return null
  }
  return p
}

/**
 * macOS secure-storage config dir override. Official is a plain directory
 * override; we additionally require an existing directory so a typo fails
 * loudly at read time instead of silently re-creating state elsewhere.
 */
export function getSecureStorageConfigDir(): string | null {
  const d = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  if (d === undefined || d === '') return null
  try {
    if (statSync(d).isDirectory()) return d
  } catch {
    // fall through to the warning below
  }
  logForDebugging(
    `[security] CLAUDE_SECURESTORAGE_CONFIG_DIR="${d}" is not an existing directory; ignoring`,
  )
  return null
}

/** Presence probe for /doctor-style surfaces (returns no secret material). */
export function hasGatewayTokenConfigured(): boolean {
  return getGatewayToken() !== null
}
