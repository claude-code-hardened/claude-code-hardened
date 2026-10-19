/**
 * W4 (#55) — sandbox decision telemetry (structure first).
 *
 * This module only defines the decision record and the recording seam. It is
 * deliberately NOT wired into production call sites yet: emitting from
 * permission/sandbox surfaces crosses file-domain boundaries owned by other
 * work packages. The wiring points, when picked up:
 *
 *   1. Decision gate — packages/builtin-tools/src/tools/BashTool/shouldUseSandbox.ts
 *      (records requiresConfiningSandbox + the resulting sandboxed/unsandboxed
 *      branch for the current input).
 *   2. BashTool call face — packages/builtin-tools/src/tools/BashTool/BashTool.tsx
 *      (call/ execution path already knows the attributionId and whether
 *      dangerouslyDisableSandbox was requested/overridden).
 *
 * until then the in-memory buffer only fills when something calls
 * recordSandboxDecision() (tests, /doctor-style surfaces).
 */

import { logForDebugging } from '../debug.js'

export type SandboxDecisionTelemetry = {
  /** Correlates the decision with the tool-use / attribution record. */
  attributionId?: string
  /** Decision was observed on a masked/redacted surface (no raw command material retained). */
  masked?: boolean
  /** Read denials in effect for this decision. */
  denyRead?: boolean
  /** Write denials in effect for this decision. */
  denyWrite?: boolean
  /** The command requires a confining sandbox to be allowed at all. */
  requiresConfiningSandbox: boolean
}

const RECENT_LIMIT = 100

const recentDecisions: SandboxDecisionTelemetry[] = []

/**
 * Record one sandbox decision. Bounded in-memory buffer (last 100) + a single
 * debug line; never throws on malformed input, and never reads command text
 * (callers pass masks/denials, not payloads).
 */
export function recordSandboxDecision(
  decision: SandboxDecisionTelemetry,
): void {
  recentDecisions.push(decision)
  if (recentDecisions.length > RECENT_LIMIT) {
    recentDecisions.shift()
  }
  logForDebugging(
    `[sandbox-telemetry] decision recorded: confining=${decision.requiresConfiningSandbox}` +
      ` masked=${decision.masked ?? false}` +
      ` denyRead=${decision.denyRead ?? false} denyWrite=${decision.denyWrite ?? false}` +
      (decision.attributionId ? ` attribution=${decision.attributionId}` : ''),
  )
}

/** Recent decisions, oldest first (read-only view for diagnostics/tests). */
export function getRecentSandboxDecisions(): readonly SandboxDecisionTelemetry[] {
  return recentDecisions
}

/** Clear the buffer (test seam / diagnostics reset). */
export function resetSandboxDecisionTelemetry(): void {
  recentDecisions.length = 0
}
