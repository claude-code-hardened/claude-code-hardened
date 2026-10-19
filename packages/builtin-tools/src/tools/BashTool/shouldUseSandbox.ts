import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { splitCommand_DEPRECATED } from 'src/utils/bash/commands.js'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import {
  BINARY_HIJACK_VARS,
  bashPermissionRule,
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from './bashPermissions.js'

type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

// NOTE: excludedCommands is a user-facing convenience feature, not a security boundary.
// It is not a security bug to be able to bypass excludedCommands — the sandbox permission
// system (which prompts users) is the actual security control.
function containsExcludedCommand(command: string): boolean {
  // Check dynamic config for disabled commands and substrings (only for ants)
  if (process.env.USER_TYPE === 'ant') {
    const disabledCommands = getFeatureValue_CACHED_MAY_BE_STALE<{
      commands: string[]
      substrings: string[]
    }>('tengu_sandbox_disabled_commands', { commands: [], substrings: [] })

    // Check if command contains any disabled substrings
    for (const substring of disabledCommands.substrings) {
      if (command.includes(substring)) {
        return true
      }
    }

    // Check if command starts with any disabled commands
    try {
      const commandParts = splitCommand_DEPRECATED(command)
      for (const part of commandParts) {
        const baseCommand = part.trim().split(' ')[0]
        if (baseCommand && disabledCommands.commands.includes(baseCommand)) {
          return true
        }
      }
    } catch {
      // If we can't parse the command (e.g., malformed bash syntax),
      // treat it as not excluded to allow other validation checks to handle it
      // This prevents crashes when rendering tool use messages
    }
  }

  // Check user-configured excluded commands from settings
  const settings = getSettings_DEPRECATED()
  const userExcludedCommands = settings.sandbox?.excludedCommands ?? []

  if (userExcludedCommands.length === 0) {
    return false
  }

  // Split compound commands (e.g. "docker ps && curl evil.com") into individual
  // subcommands and check each one against excluded patterns. This prevents a
  // compound command from escaping the sandbox just because its first subcommand
  // matches an excluded pattern.
  let subcommands: string[]
  try {
    subcommands = splitCommand_DEPRECATED(command)
  } catch {
    subcommands = [command]
  }

  for (const subcommand of subcommands) {
    const trimmed = subcommand.trim()
    // Also try matching with env var prefixes and wrapper commands stripped, so
    // that `FOO=bar bazel ...` and `timeout 30 bazel ...` match `bazel:*`. Not a
    // security boundary (see NOTE at top); the &&-split above already lets
    // `export FOO=bar && bazel ...` match. BINARY_HIJACK_VARS kept as a heuristic.
    //
    // We iteratively apply both stripping operations until no new candidates are
    // produced (fixed-point), matching the approach in filterRulesByContentsMatchingInput.
    // This handles interleaved patterns like `timeout 300 FOO=bar bazel run`
    // where single-pass composition would fail.
    const candidates = [trimmed]
    const seen = new Set(candidates)
    let startIdx = 0
    while (startIdx < candidates.length) {
      const endIdx = candidates.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = candidates[i]!
        const envStripped = stripAllLeadingEnvVars(cmd, BINARY_HIJACK_VARS)
        if (!seen.has(envStripped)) {
          candidates.push(envStripped)
          seen.add(envStripped)
        }
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          candidates.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }

    for (const pattern of userExcludedCommands) {
      const rule = bashPermissionRule(pattern)
      for (const cand of candidates) {
        switch (rule.type) {
          case 'prefix':
            if (cand === rule.prefix || cand.startsWith(rule.prefix + ' ')) {
              return true
            }
            break
          case 'exact':
            if (cand === rule.command) {
              return true
            }
            break
          case 'wildcard':
            if (matchWildcardPattern(rule.pattern, cand)) {
              return true
            }
            break
        }
      }
    }
  }

  return false
}

/** Sandbox execution mode decided for one tool call. */
export type SandboxDecisionMode = 'sandbox' | 'unsandboxed' | 'refuse'

/** Why a refused command is rejected outright (official tn 0051:729). */
export type SandboxDecisionReason = 'sandbox_unavailable' | 'policy_disabled'

export type SandboxDecision = {
  mode: SandboxDecisionMode
  reason?: SandboxDecisionReason
}

/**
 * Official tn(0051:729) decision semantics, including the refuse face.
 *
 * When the strict/closed managed-policy gate hits (strictSandboxMode
 * configured, or the model's dangerouslyDisableSandbox opt-out denied by
 * unsandboxedCommandsDisabled) AND the sandbox cannot actually be provided
 * (unsupported platform, or sandbox.enabled pinned but dependencies missing —
 * getSandboxUnavailableReason() non-undefined), the command is refused
 * outright instead of being forced into a sandbox that fails to materialize
 * and then silently falling through to a bare-metal run.
 *
 * Boundary (official four-condition gate includes `enabled`): a globally
 * disabled sandbox (isSandboxingEnabled() false with no availability error)
 * is plain non-enforcement — no refuse, plain unsandboxed execution.
 */
export function evaluateSandboxDecision(
  input: Partial<SandboxInput>,
): SandboxDecision {
  const strict = SandboxManager.isStrictSandboxModeConfigured()
  // The escape hatch is closed for this call: the model tried to opt out and
  // policy denies unsandboxed execution (unsandboxedCommandsDisabled / closed
  // allowUnsandboxedCommands).
  const optOutDenied =
    input.dangerouslyDisableSandbox === true &&
    SandboxManager.areUnsandboxedCommandsDisabled()

  if (strict || optOutDenied) {
    const sandboxUnavailable =
      !SandboxManager.isSupportedPlatform() ||
      SandboxManager.getSandboxUnavailableReason() !== undefined
    if (sandboxUnavailable) {
      return {
        mode: 'refuse',
        reason: strict ? 'sandbox_unavailable' : 'policy_disabled',
      }
    }
  }

  // Below this line the pre-W4 decision, verbatim; `mode: 'unsandboxed'` maps
  // to the old `return false` and `mode: 'sandbox'` to `return true`.
  if (!SandboxManager.isSandboxingEnabled()) {
    return { mode: 'unsandboxed' }
  }

  // Strict managed mode (W4): the model's dangerouslyDisableSandbox opt-out
  // is ignored outright; policy decides, not the tool call.
  if (input.dangerouslyDisableSandbox && strict) {
    return { mode: 'sandbox' }
  }

  // Don't sandbox if explicitly overridden AND unsandboxed commands are allowed by policy
  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return { mode: 'unsandboxed' }
  }

  if (!input.command) {
    return { mode: 'unsandboxed' }
  }

  // Don't sandbox if the command contains user-configured excluded commands
  if (containsExcludedCommand(input.command)) {
    return { mode: 'unsandboxed' }
  }

  return { mode: 'sandbox' }
}

export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  return evaluateSandboxDecision(input).mode === 'sandbox'
}
