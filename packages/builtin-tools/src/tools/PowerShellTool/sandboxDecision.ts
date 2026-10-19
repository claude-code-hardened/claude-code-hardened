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
import { shouldUseSandbox } from '../BashTool/shouldUseSandbox.js'

export type PowerShellSandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

export function shouldUseSandboxForPowerShell(
  input: PowerShellSandboxInput,
): boolean {
  // Strict managed mode: the opt-out is refused; policy decides, not the
  // tool call.
  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.isStrictSandboxModeConfigured()
  ) {
    return true
  }

  // Non-strict paths keep the shared decision surface (hatch interplay,
  // excludedCommands) — identical sandboxing wrap as bash.
  return shouldUseSandbox(input)
}
