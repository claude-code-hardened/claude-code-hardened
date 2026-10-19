import { getSettingsForSource } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { logForDebugging } from '../debug.js'

/**
 * W4 (#55): the policySettings settings source merges like any other source
 * (first-source-wins, see settings.ts), but enterprises also need to know
 * whether policy — not user preference — is what's driving a value, and the
 * GPO helper (policyHelper.ts) needs the raw policy shape to emit.
 *
 * This module is the read/validation layer over that source. It intentionally
 * does not re-parse config files: getCachedSettingsForSource already resolved
 * managed paths (HKLM/plist/managed-settings.json).
 */
export type PolicySettings = Partial<SettingsJson> & {
  // Explicitly-typed well-known policy keys (schema validated at read time
  // by the settings pipeline; unknown keys pass through untouched).
}

export function getPolicySettings(): PolicySettings | null {
  const policy = getSettingsForSource('policySettings')
  if (!policy) return null
  return policy as PolicySettings
}

export function isPolicyEnforced(): boolean {
  return getPolicySettings() !== null
}

/**
 * True when the policy layer explicitly pins a sandbox decision. Used by the
 * sandbox strict-mode gates so user preferences cannot override managed
 * policy, and surfaced by /doctor for "managed by policy" flags.
 *
 * Official double condition (tn 0051): the key must hit the policy layer AND,
 * for `enabled`, its value must actually be true — a sandbox policy block that
 * merely carries unrelated knobs (autoAllowBashIfSandboxed, …) or explicitly
 * sets enabled=false does not pin sandboxing on.
 */
export function isSandboxDecisionPolicyPinned(
  key:
    | 'enabled'
    | 'strictSandboxMode'
    | 'unsandboxedCommandsDisabled'
    | 'allowUnsandboxedCommands',
): boolean {
  const policy = getPolicySettings()
  const sandbox = policy?.sandbox
  if (sandbox == null || typeof sandbox !== 'object') return false
  if (!(key in sandbox)) return false
  if (key === 'enabled') {
    return sandbox.enabled === true
  }
  return true
}

export function validatePolicyLayer(): string[] {
  const problems: string[] = []
  const policy = getPolicySettings()
  if (!policy) return problems
  const sandbox = policy.sandbox
  if (sandbox != null && typeof sandbox !== 'object') {
    problems.push('policySettings.sandbox must be an object')
  }
  if (sandbox != null && typeof sandbox === 'object') {
    for (const booleanKey of [
      'enabled',
      'strictSandboxMode',
      'unsandboxedCommandsDisabled',
      'allowUnsandboxedCommands',
    ] as const) {
      const v = (sandbox as Record<string, unknown>)[booleanKey]
      if (v !== undefined && typeof v !== 'boolean') {
        problems.push(`policySettings.sandbox.${booleanKey} must be a boolean`)
      }
    }
  }
  if (problems.length > 0) {
    logForDebugging(
      `[policy] policySettings validation problems: ${problems.join('; ')}`,
    )
  }
  return problems
}
