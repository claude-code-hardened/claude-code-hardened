/**
 * W4 (#55) — pure sandbox decision predicates.
 *
 * Extracted verbatim from sandbox-adapter.ts so the W4 decision logic (the
 * unsandboxedCommandsDisabled short-circuit, the strict-mode flag and the
 * escape-hatch interplay) can be unit-tested without dragging in the
 * sandbox-adapter import graph (settings, bootstrap state, sandbox-runtime).
 * sandbox-adapter delegates to these with the live merged settings; behavior
 * is unchanged.
 *
 * R4: the one deliberate live dependency is the policySettings read below —
 * "policy pins sandbox.enabled=true" closes the escape hatch regardless of
 * merged user preference (policy beats user). Everything else stays pure over
 * the merged settings passed in.
 */

import {
  getPolicySettings,
  isSandboxDecisionPolicyPinned,
} from '../policy/policySettings.js'

export type SandboxSettingsLike = {
  strictSandboxMode?: boolean
  unsandboxedCommandsDisabled?: boolean
  allowUnsandboxedCommands?: boolean
}

export type SettingsWithSandbox =
  | {
      sandbox?: SandboxSettingsLike
    }
  | undefined
  | null

/**
 * True when commands may escape the sandbox via dangerouslyDisableSandbox.
 *
 * W4: unsandboxedCommandsDisabled is the hard no-escape flag — when set, the
 * escape hatch is closed regardless of allowUnsandboxedCommands.
 *
 * R4: when the policy layer pins sandbox.enabled=true (double condition —
 * key present AND value true, see isSandboxDecisionPolicyPinned), the hatch
 * is closed too; only the policy layer itself explicitly allowing
 * unsandboxed commands reopens it — a user-level allowUnsandboxedCommands
 * cannot.
 */
export function areUnsandboxedCommandsAllowedIn(
  settings: SettingsWithSandbox,
): boolean {
  // Hard no-escape flag: closed escape hatch wins over allowUnsandboxedCommands.
  if (settings?.sandbox?.unsandboxedCommandsDisabled) return false
  // Policy pin beats user preference: sandboxing has been explicitly turned
  // on by policy, so the opt-out is closed unless policy itself allows it.
  if (isSandboxDecisionPolicyPinned('enabled')) {
    return getPolicySettings()?.sandbox?.allowUnsandboxedCommands === true
  }
  return settings?.sandbox?.allowUnsandboxedCommands ?? true
}

/** Strict managed mode: dangerouslyDisableSandbox opt-outs are refused. */
export function isStrictSandboxModeConfiguredIn(
  settings: SettingsWithSandbox,
): boolean {
  return settings?.sandbox?.strictSandboxMode ?? false
}

/** Negated form of areUnsandboxedCommandsAllowedIn (W4 helper). */
export function areUnsandboxedCommandsDisabledIn(
  settings: SettingsWithSandbox,
): boolean {
  return !areUnsandboxedCommandsAllowedIn(settings)
}
