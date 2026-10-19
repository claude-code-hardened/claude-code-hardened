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

/** Why a refused command is rejected outright (official tn 0051:729).
 * `partial_exclusion` is the official Gs face: the command matches a sandbox
 * exclusion only in part (compound / metacharacter form), while
 * `policy_disabled` is the official Ks face: the exclusion would exempt the
 * command but unsandboxed execution cannot be approved. */
export type SandboxDecisionReason =
  | 'sandbox_unavailable'
  | 'policy_disabled'
  | 'partial_exclusion'

export type SandboxDecision = {
  mode: SandboxDecisionMode
  reason?: SandboxDecisionReason
}

/**
 * Refusal texts for the three refuse faces (shared verbatim by BashTool and
 * PowerShellTool — "tool error 同 Bash 文案").
 *
 * Official wording (0051-chunk-bxerm1mk:729, variables Gs/Ks, Windows-scoped
 * there):
 *   Gs = "Enterprise policy requires sandboxing, but this command would not
 *   be sandboxed on Windows: either the sandbox is unavailable, or the command
 *   matches a sandbox exclusion pattern only in part. Compound commands and
 *   commands with shell metacharacters must run sandboxed even when a
 *   statement matches an exclusion. Shell command execution is blocked by
 *   policy."
 *   Ks = "Enterprise policy requires sandboxing, but the sandbox is
 *   unavailable on Windows. The command matches a sandbox exclusion pattern,
 *   but exclusions only exempt a command where a permission prompt can
 *   approve the unsandboxed run, and none is available here. Shell command
 *   execution is blocked by policy."
 *
 * Adaptation declared per W4 review: the official texts hard-code "on
 * Windows" (the official gate is the Windows-only tn()); this gate is
 * platform-general, so the platform clause is dropped and the availability /
 * partial-exclusion clauses are kept 1:1.
 */
export const SANDBOX_REFUSAL_MESSAGES: Record<SandboxDecisionReason, string> = {
  sandbox_unavailable:
    'Enterprise policy requires sandboxing, but the sandbox is unavailable. Shell command execution is blocked by policy.',
  policy_disabled:
    'Enterprise policy requires sandboxing, but unsandboxed command execution is disabled by policy: exclusions only exempt a command where a permission prompt can approve the unsandboxed run, and none is available here. Shell command execution is blocked by policy.',
  partial_exclusion:
    'Enterprise policy requires sandboxing, but this command would not be sandboxed: it matches a sandbox exclusion pattern only in part. Compound commands and commands with shell metacharacters must run sandboxed even when a statement matches an exclusion. Shell command execution is blocked by policy.',
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
 *
 * R2 (Q4-3) — official tn(0051:729) short-circuits the refusal off when the
 * platform is restricted via enabledPlatforms:
 *   `function tn(e,n,r){if(r||I()!=="windows"||!ze.isSandboxEnabledInSettings()
 *      ||!ze.isPlatformInEnabledList()||!ze.isStrictSandboxModeConfigured()||e)
 *      return null; …}`
 * An enabledPlatforms restriction disables sandboxing for that platform but is
 * NOT part of the strict-refusal category — the gate falls through to the
 * plain unsandboxed path instead of refusing.
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
    // R2 (Q4-3): an enabledPlatforms restriction is never a strict-refusal
    // trigger (official tn verbatim above) — treat it as non-refusing and let
    // the isSandboxingEnabled() === false path below run the command
    // unsandboxed.
    const platformInEnabledList = SandboxManager.isPlatformInEnabledList()
    const sandboxUnavailable =
      !SandboxManager.isSupportedPlatform() ||
      (platformInEnabledList &&
        SandboxManager.getSandboxUnavailableReason() !== undefined)
    if (sandboxUnavailable) {
      // R2 (Q4-1) — official tn(0051:729) exclusion carve-out, verbatim:
      //   `if(!Rho(n))return Gs;return C1().unsandboxedCommandsDisabled?Ks:null`
      // An excluded command may still run unsandboxed — but only when the
      // exclusion cleanly covers the whole command (official `Rho`, 0001
      // chunk: simple command + full-command rule match). The carve-out does
      // not apply to model opt-out calls (official tn `…||e` short-circuits
      // before the exclusion logic; the Nh path governs those).
      if (
        strict &&
        input.dangerouslyDisableSandbox !== true &&
        input.command !== undefined &&
        containsExcludedCommand(input.command)
      ) {
        if (!isRhoCleanExclusionMatch(input.command)) {
          return { mode: 'refuse', reason: 'partial_exclusion' }
        }
        if (SandboxManager.areUnsandboxedCommandsDisabled()) {
          return { mode: 'refuse', reason: 'policy_disabled' }
        }
        return { mode: 'unsandboxed' }
      }
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

  // Don't sandbox if the command contains user-configured excluded commands.
  // R2 (Q4-1): under strict managed policy the exemption narrows to the
  // official `Rho` semantics — a compound command (or one with shell
  // metacharacters) "must run sandboxed even when a statement matches an
  // exclusion" (official Gs, 0051-chunk-bxerm1mk:729), so only a cleanly
  // excluded simple command escapes; partial matches stay sandboxed.
  if (input.command !== undefined && containsExcludedCommand(input.command)) {
    if (strict && !isRhoCleanExclusionMatch(input.command)) {
      return { mode: 'sandbox' }
    }
    return { mode: 'unsandboxed' }
  }

  return { mode: 'sandbox' }
}

/**
 * Verbatim port of the official `Rho` exclusion-check (0001-chunk-xrzcaagk,
 * `function Rho(e)` + the `JLe` matcher) narrowed to what the Bash-side
 * decision surface needs: the command is only cleanly excludable when the
 * FULL trimmed command itself matches one exclusion rule (prefix == whole
 * command, exact equality, or wildcard) and the command is not a compound or
 * obfuscated form (multi-statement split, quoted first token). Officially the
 * rule list comes from the excluded-commands settings via `nGn()`, mirrored
 * here by `sandbox.excludedCommands`.
 *
 * Official `JLe(e,n)`: `case"prefix":return n===e.prefix||n.startsWith(e.prefix+" ");
 * case"exact":return n===e.command;case"wildcard":return hR(e.pattern,n)`.
 */
export function isRhoCleanExclusionMatch(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed.length === 0) return false

  // Rho's compound/obfuscation screen: a command that splits into more than
  // one statement (&&, ;, |, …) never cleanly matches — Gs text (0051:729):
  // "Compound commands and commands with shell metacharacters must run
  // sandboxed even when a statement matches an exclusion."
  let subcommands: string[]
  try {
    subcommands = splitCommand_DEPRECATED(trimmed)
  } catch {
    return false
  }
  if (subcommands.length > 1) return false

  // Rho: `if(/['"‘-’“-„]/.test(r.split(/[ \t]+/)[0]??""))return!1` — a quoted
  // first token hides the real command and is not cleanly excludable.
  const firstToken = trimmed.split(/[ \t]+/)[0] ?? ''
  if (/['"‘-’“-„]/.test(firstToken)) return false

  const userExcludedCommands =
    getSettings_DEPRECATED().sandbox?.excludedCommands ?? []
  if (userExcludedCommands.length === 0) return false

  return userExcludedCommands.some(pattern => {
    const rule = bashPermissionRule(pattern)
    switch (rule.type) {
      case 'prefix':
        return trimmed === rule.prefix || trimmed.startsWith(rule.prefix + ' ')
      case 'exact':
        return trimmed === rule.command
      case 'wildcard':
        return matchWildcardPattern(rule.pattern, trimmed)
    }
  })
}

export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  return evaluateSandboxDecision(input).mode === 'sandbox'
}
