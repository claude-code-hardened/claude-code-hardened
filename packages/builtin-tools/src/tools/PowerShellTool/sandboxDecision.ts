/**
 * R4 (#0051) — PowerShell-side sandbox decision.
 *
 * The strict managed-mode refusal is a property of every shell entry point
 * (official tn()): when sandbox policy configures strictSandboxMode, the
 * call is refused outright when the sandbox cannot be provided, exactly like
 * bash — official composition (0051-chunk-bxerm1mk:731):
 *   `g = Be(n, …)`            — the SAME shared decision call BashTool uses;
 *   `_= tn(g, n.command, h && n.dangerouslyDisableSandbox === !0)`
 *   `if (_ !== null) throw … new bte(_)`
 * The decision surface is one shared three-state mapping; the refusal is
 * decided inside it and does NOT exempt the model's dangerouslyDisableSandbox
 * opt-out (the official `r` third argument is the user-typed shell dispatch
 * face, not the model field). A dedicated PowerShell strict short-circuit
 * that force-modeled `{mode:'sandbox'}` before any availability check made
 * PowerShell agree with Bash on every input EXCEPT the refuse faces — the
 * same strict+opt-out+unavailable input refused on Bash but silently forced
 * the sandbox branch here. The surfaces are now literally the same function.
 *
 * PowerShell's sandbox execution form is the same POSIX wrap as bash (pwsh
 * runs as a native binary under SandboxManager.wrapWithSandbox; see the exec
 * options in PowerShellTool.tsx), so the shared decision surface (strict
 * gate, unsandboxed-commands hatch, excludedCommands + Rho carve-out)
 * composes unchanged.
 */
import type { SandboxDecision } from '../BashTool/shouldUseSandbox.js'
import { evaluateSandboxDecision } from '../BashTool/shouldUseSandbox.js'

export type PowerShellSandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

/** PowerShell three-state sandbox decision (R2 #0051): the shared surface
 * (refuse faces + exclusion carve-out) — refuse → the caller surfaces a tool
 * error with the shared refusal texts (SANDBOX_REFUSAL_MESSAGES). */
export function evaluateSandboxDecisionForPowerShell(
  input: PowerShellSandboxInput,
): SandboxDecision {
  return evaluateSandboxDecision(input)
}

export function shouldUseSandboxForPowerShell(
  input: PowerShellSandboxInput,
): boolean {
  return evaluateSandboxDecisionForPowerShell(input).mode === 'sandbox'
}
