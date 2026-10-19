/**
 * Bridge disconnect-reattach env face (work package W7, task #58 block 1).
 *
 * Official anchors (decompiled):
 *   - 0143-chunk-zrkp23rq/module-003-uncategorized.js:815 —
 *     `oe = process.env.CLAUDE_BRIDGE_REATTACH_SESSION` picks the resume
 *     session (env beats the crash-recovery pointer: `B = oe ?? Je`), then —
 *     GATED ON THE SESSION BEING PRESENT (`if (oe)`) — the FULL reattach env
 *     family is deleted from process.env so a session respawned by the
 *     supervisor doesn't inherit any of it:
 *       SESSION, SEQ, OUTBOUND_ONLY, GROUPING, OWNER_ACCT, OWNER_ORG,
 *       NO_BACKFILL
 *     (0143 also reads SEQ/GROUPING/OWNER_ACCT/OWNER_ORG/NO_BACKFILL for the
 *     resume projection; this face covers the two vars the work package
 *     consumes, and now clears all siblings too — R7: previously only the two
 *     consumed vars were deleted, and OUTBOUND_ONLY was deleted even without
 *     a session, both deviating from the official read-and-forget snapshot).
 *   - 0044-chunk-zrkp23rq/module-003-uncategorized.js:1415 —
 *     `P = Boolean(CLAUDE_BRIDGE_REATTACH_SESSION)` forces the repl bridge
 *     enabled for the reattach, and `V = CLAUDE_BRIDGE_REATTACH_OUTBOUND_ONLY`
 *     picks the outbound-only control profile for that reattached session
 *     (mutable control_requests rejected — see handleServerControlRequest).
 *
 * CCH usage points: bridgeMain.ts applies the env session over the pointer
 * derivation (resume/reconnect surface), and initReplBridge.ts folds the
 * outbound-only profile into the bridge core options.
 */

import { logForDebugging } from '../utils/debug.js'
import { isEnvTruthy } from '../utils/envUtils.js'

export const BRIDGE_REATTACH_SESSION_ENV = 'CLAUDE_BRIDGE_REATTACH_SESSION'
export const BRIDGE_REATTACH_OUTBOUND_ONLY_ENV =
  'CLAUDE_BRIDGE_REATTACH_OUTBOUND_ONLY'

/**
 * The unread siblings the spawn chain may set (official 0143 env-var list).
 * CCH does not consume them, but consume must still scrub them so a respawned
 * child never re-inherits them (official deletes the whole family at once).
 */
const BRIDGE_REATTACH_SIBLING_ENVS = [
  'CLAUDE_BRIDGE_REATTACH_SEQ',
  'CLAUDE_BRIDGE_REATTACH_GROUPING',
  'CLAUDE_BRIDGE_REATTACH_OWNER_ACCT',
  'CLAUDE_BRIDGE_REATTACH_OWNER_ORG',
  'CLAUDE_BRIDGE_REATTACH_NO_BACKFILL',
] as const

export type BridgeReattachEnv = {
  /** Session to reattach to (CLAUDE_BRIDGE_REATTACH_SESSION). */
  sessionId?: string
  /** Run the reattached session outbound-only (no inbound control). */
  outboundOnly: boolean
}

let consumed: BridgeReattachEnv | null = null

/** Non-destructive peek — safe to call before the consume moment. */
export function peekBridgeReattachSession(): string | undefined {
  const value = process.env[BRIDGE_REATTACH_SESSION_ENV]
  if (value === undefined || value.trim() === '') return undefined
  return value.trim()
}

/** Non-destructive outbound-only check. */
export function isBridgeReattachOutboundOnly(): boolean {
  if (consumed) return consumed.outboundOnly
  return isEnvTruthy(process.env[BRIDGE_REATTACH_OUTBOUND_ONLY_ENV])
}

/**
 * Read-and-forget, official semantics: when a reattach session is present,
 * the FULL CLAUDE_BRIDGE_REATTACH_* family (SESSION, OUTBOUND_ONLY and the
 * unread SEQ/GROUPING/OWNER_ACCT/OWNER_ORG/NO_BACKFILL siblings) is deleted
 * after the single read so grand-children don't reattach or act on stale
 * reattach state. With NO session present, nothing is deleted (official
 * behavior: `V`/siblings are only scrubbed inside the `if (oe)` branch) —
 * the consumed latch still freezes the outbound-only answer for this process.
 * Idempotent — the first call wins.
 */
export function consumeBridgeReattachEnv(): BridgeReattachEnv {
  if (consumed) return consumed
  const sessionId = peekBridgeReattachSession()
  const outboundOnly = isEnvTruthy(
    process.env[BRIDGE_REATTACH_OUTBOUND_ONLY_ENV],
  )
  if (sessionId !== undefined) {
    delete process.env[BRIDGE_REATTACH_SESSION_ENV]
    delete process.env[BRIDGE_REATTACH_OUTBOUND_ONLY_ENV]
    for (const sibling of BRIDGE_REATTACH_SIBLING_ENVS) {
      delete process.env[sibling]
    }
  }
  consumed = { sessionId, outboundOnly }
  logForDebugging(
    `[bridge:reattach] session=${sessionId ?? 'none'} outboundOnly=${outboundOnly}`,
  )
  return consumed
}

/** Test hook — clears the consumed latch between tests. */
export function resetBridgeReattachEnv(): void {
  consumed = null
}
