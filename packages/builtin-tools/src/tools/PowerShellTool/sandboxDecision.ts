/**
 * R4 (#0051) — PowerShell-side sandbox decision.
 *
 * The strict managed-mode refusal is a property of every shell entry point
 * (official tn()): when sandbox policy configures strictSandboxMode, the
 * model's dangerouslyDisableSandbox opt-out is ignored outright and the call
 * is forced through the sandbox branch — on PowerShell exactly as on Bash.
 *
 * PowerShell's sandbox execution form is the same POSIX wrap as bash (pwsh
 * runs as a native binary under SandboxManager.wrapWithSandbox; see the exec
 * options in PowerShellTool.tsx), so everything past the strict gate (the
 * unsandboxed-commands hatch, excludedCommands) composes with the shared Bash
 * decision surface. The gate itself is kept PowerShell-local — owned and
 * unit-tested in this package instead of only transitively via BashTool —
 * and doubles as defense-in-depth: the shared shouldUseSandbox applies the
 * same gate.
 */
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import {
  evaluateSandboxDecision,
  type SandboxDecision,
} from '../BashTool/shouldUseSandbox.js'

export type PowerShellSandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

/** PowerShell three-state sandbox decision (R2 #0051): the shared tn() gate
 * (refuse faces + exclusion carve-out) composed after the PowerShell-local
 * strict opt-out refusal. refuse → the caller surfaces a tool error with the
 * Bash-verbatim refusal texts (SANDBOX_REFUSAL_MESSAGES). */
export function evaluateSandboxDecisionForPowerShell(
  input: PowerShellSandboxInput,
): SandboxDecision {
  // Strict managed mode: the model's dangerouslyDisableSandbox opt-out is
  // refused; policy decides, not the tool call (official tn `…||e` keeps the
  // opt-out call out of the tn refusal, but the PowerShell surface still
  // forces the sandbox branch — same composition as BashTool).
  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.isStrictSandboxModeConfigured()
  ) {
    return { mode: 'sandbox' }
  }

  // Non-strict paths keep the shared decision surface (hatch interplay,
  // excludedCommands + the Rho-clean exemption carve-out) — identical
  // sandboxing wrap as bash.
  return evaluateSandboxDecision(input)
}

export function shouldUseSandboxForPowerShell(
  input: PowerShellSandboxInput,
): boolean {
  return evaluateSandboxDecisionForPowerShell(input).mode === 'sandbox'
}
