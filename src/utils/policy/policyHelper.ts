/**
 * W4 (#55) — Windows GPO export helper for policySettings.
 *
 * Enterprises managing Claude Code through Group Policy need a way to turn the
 * policySettings shape (the same JSON admins already review) into something a
 * Windows admin can replay on managed machines. This module renders it as a
 * readable + replayable PowerShell artifact:
 *
 *   - a flattened `policy path → HKLM registry value` table (REG_DWORD/REG_SZ),
 *   - the raw policy JSON block (source of truth for round-tripping),
 *   - `Set-ItemProperty` statements targeting
 *     HKLM\SOFTWARE\Policies\Anthropic\ClaudeCode.
 *
 * The helper never renders secret material (tokens, keys): before anything is
 * rendered for disk, redactPolicySecrets() deep-clones the policy and replaces
 * the values of entries whose key name contains TOKEN/KEY/SECRET/PHRASE or
 * PASSWORD (case-insensitive) with `<redacted>`. This covers both the
 * flattened registry table and the raw JSON block (W4 R4 hardening — the doc
 * previously claimed admin poetry would keep secrets out; now it is enforced).
 *
 * Writing is opt-in: writePolicyHelperFiles() is a debug-logged no-op unless a
 * destination is provided (opts override env, which overrides nothing) and the
 * process runs on win32 — unless the caller forces it via opts on another
 * platform.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { logForDebugging } from '../debug.js'
import { getPolicySettings } from './policySettings.js'

/** Registry hive root where Claude Code policy values are published. */
export const POLICY_REGISTRY_ROOT =
  'HKLM\\SOFTWARE\\Policies\\Anthropic\\ClaudeCode'
const POLICY_REGISTRY_POWERSHELL_ROOT =
  'HKLM:\\SOFTWARE\\Policies\\Anthropic\\ClaudeCode'

/** Sentinel written in place of any secret-keyed policy value. */
export const POLICY_SECRET_REDACTED = '<redacted>'

/** Key-name patterns whose values never reach a written artifact. */
const SECRET_KEY_PATTERN = /TOKEN|KEY|SECRET|PHRASE|PASSWORD/i

function redactNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactNode)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = SECRET_KEY_PATTERN.test(key)
        ? POLICY_SECRET_REDACTED
        : redactNode(child)
    }
    return out
  }
  return value
}

/**
 * Deep-clone the policy with the values of secret-keyed entries — key names
 * containing TOKEN/KEY/SECRET/PHRASE/PASSWORD (case-insensitive), at any
 * depth — replaced with `<redacted>`. Applied to every artifact the helper
 * writes (flattened table, JSON block, registry replay commands), so
 * credentials pasted into a policy block cannot leak into the GPO export.
 */
export function redactPolicySecrets(
  policy: Record<string, unknown>,
): Record<string, unknown> {
  return redactNode(policy) as Record<string, unknown>
}

export type PolicyExportEntry = {
  /** Dotted policy path, e.g. "sandbox.enabled". */
  path: string
  /** Registry value type chosen for the leaf. */
  type: 'REG_DWORD' | 'REG_SZ'
  /** Value formatted for the registry (DWORD numeric string, or literal). */
  value: string
}

function toPascalCase(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1)
}

/** PowerShell single-quoted literal: double embedded single quotes. */
function psSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Flatten the policy object into registry entries. Objects expand into
 * PascalCase subkey chains; scalars become values, where booleans/integers are
 * REG_DWORD (booleans as 1/0) and everything else is REG_SZ (arrays and other
 * structures are JSON-encoded so replay is lossless).
 */
export function flattenPolicySettings(
  policy: Record<string, unknown>,
): PolicyExportEntry[] {
  const entries: PolicyExportEntry[] = []

  const walk = (node: unknown, prefix: string[]): void => {
    if (node === null || node === undefined) return
    if (
      typeof node === 'object' &&
      !Array.isArray(node) &&
      Object.keys(node).length > 0
    ) {
      for (const [key, child] of Object.entries(
        node as Record<string, unknown>,
      )) {
        if (child === undefined || child === null) continue
        walk(child, [...prefix, key])
      }
      return
    }
    // Human-readable dotted path keeps the settings keys as written
    // (e.g. sandbox.enabled); registry mapping re-PascalCases at emit time.
    const displayPath = prefix.join('.')
    if (typeof node === 'boolean') {
      entries.push({
        path: displayPath,
        type: 'REG_DWORD',
        value: node ? '1' : '0',
      })
    } else if (typeof node === 'number' && Number.isInteger(node)) {
      entries.push({
        path: displayPath,
        type: 'REG_DWORD',
        value: String(node),
      })
    } else if (typeof node === 'string') {
      entries.push({ path: displayPath, type: 'REG_SZ', value: node })
    } else {
      entries.push({
        path: displayPath,
        type: 'REG_SZ',
        value: JSON.stringify(node),
      })
    }
  }

  walk(policy, [])
  return entries
}

/** Registry subkey path for an entry's dotted path (root + PascalCase dirs). */
function registryKeyPathFor(entry: PolicyExportEntry): string {
  const segments = entry.path.split('.')
  const dirSegments = segments.slice(0, -1).map(toPascalCase)
  return [POLICY_REGISTRY_POWERSHELL_ROOT, ...dirSegments].join('\\')
}

/** Registry value name for an entry (PascalCase leaf). */
function registryValueNameFor(entry: PolicyExportEntry): string {
  const leaf = entry.path.split('.').pop() ?? entry.path
  return toPascalCase(leaf)
}

/** Render the set/replay commands from the flattened entries. */
export function buildRegistryCommands(entries: PolicyExportEntry[]): string[] {
  const commands: string[] = []
  const seenKeys = new Set<string>()
  for (const entry of entries) {
    const keyPath = registryKeyPathFor(entry)
    if (!seenKeys.has(keyPath)) {
      seenKeys.add(keyPath)
      commands.push(
        `New-Item -Path ${psSingleQuote(keyPath)} -Force | Out-Null`,
      )
    }
    const valueArg =
      entry.type === 'REG_DWORD' ? entry.value : psSingleQuote(entry.value)
    commands.push(
      `Set-ItemProperty -Path ${psSingleQuote(keyPath)} -Name ${psSingleQuote(registryValueNameFor(entry))} -Value ${valueArg} -Type ${entry.type.replace('REG_', '')}`,
    )
  }
  return commands
}

/**
 * Render the full GPO export text: readable flattened table + raw policy JSON
 * + replayable Set-ItemProperty statements.
 */
export function buildPolicyExports(
  policy: Record<string, unknown>,
  opts?: { generatedAtISO?: string },
): string {
  const safe = redactPolicySecrets(policy)
  const entries = flattenPolicySettings(safe)
  const generatedAt = opts?.generatedAtISO ?? new Date().toISOString()
  const json = JSON.stringify(safe, null, 2)
  const table = entries
    .map(entry => `#   ${entry.path} (${entry.type}) = ${entry.value}`)
    .join('\n')
  const commands = buildRegistryCommands(entries).join('\n')
  return [
    '# Claude Code policySettings -> Windows Group Policy export (W4 #55)',
    `# Generated: ${generatedAt}`,
    `# Registry root: ${POLICY_REGISTRY_ROOT}`,
    '# Replay with an elevated PowerShell on a managed machine.',
    '#',
    '# Policy value table (human-readable):',
    table || '#   (empty policy)',
    '#',
    '# Raw policy JSON (round-trip source of truth):',
    ...json.split('\n').map(line => `# ${line}`),
    '#',
    'Set-StrictMode -Version Latest',
    '',
    `New-Item -Path ${psSingleQuote(POLICY_REGISTRY_POWERSHELL_ROOT)} -Force | Out-Null`,
    commands,
    '',
  ].join('\n')
}

/** Render the .psm1 module variant: the same replay wrapped in a function. */
export function buildPolicyModule(policy: Record<string, unknown>): string {
  const commands = buildRegistryCommands(
    flattenPolicySettings(redactPolicySecrets(policy)),
  )
    .map(line => `        ${line}`)
    .join('\n')
  return [
    '# Claude Code policySettings helper module (W4 #55)',
    `# Registry root: ${POLICY_REGISTRY_ROOT}`,
    'function Set-ClaudeCodePolicy {',
    `    New-Item -Path ${psSingleQuote(POLICY_REGISTRY_POWERSHELL_ROOT)} -Force | Out-Null`,
    commands,
    '}',
    '',
    'Export-ModuleMember -Function Set-ClaudeCodePolicy',
    '',
  ].join('\n')
}

export type PolicyHelperFileOptions = {
  outDir?: string
  ps1Path?: string
  psmPath?: string
}

const ENV_PS1_PATH = 'CLAUDE_CODE_POLICY_HELPER_PS1_PATH'
const ENV_PSM_PATH = 'CLAUDE_CODE_POLICY_HELPER_PSMODULEPATH'

/**
 * Write the GPO export files. Destination precedence: opts > env
 * (CLAUDE_CODE_POLICY_HELPER_PS1_PATH / CLAUDE_CODE_POLICY_HELPER_PSMODULEPATH).
 *
 * Default (no opts, no env) is a debug-logged no-op. On non-win32 the default
 * path also skips — but opts-provided paths force the write regardless of
 * platform (the artifact is for Windows admin machines, the producing host
 * need not be one).
 *
 * Returns the list of files written (empty when skipped).
 */
export function writePolicyHelperFiles(
  opts?: PolicyHelperFileOptions,
): string[] {
  // Explicit opts force the write (override both env and the platform guard);
  // env-derived paths use the default behavior incl. platform skip.
  const forced =
    opts?.ps1Path !== undefined ||
    opts?.psmPath !== undefined ||
    opts?.outDir !== undefined
  const ps1Path = opts?.ps1Path ?? process.env[ENV_PS1_PATH]
  const psmPath = opts?.psmPath ?? process.env[ENV_PSM_PATH]

  if (
    ps1Path === undefined &&
    psmPath === undefined &&
    opts?.outDir === undefined
  ) {
    logForDebugging(
      `[policy] no policy helper destination (set ${ENV_PS1_PATH} / ${ENV_PSM_PATH}); GPO export skipped`,
    )
    return []
  }
  if (!forced && process.platform !== 'win32') {
    logForDebugging(
      `[policy] GPO export skipped on non-win32 host (pass opts to force)`,
    )
    return []
  }

  const policy = getPolicySettings()
  if (!policy) {
    logForDebugging(
      '[policy] no policySettings source configured; nothing to export',
    )
    return []
  }

  const written: string[] = []
  const resolvedPs1 =
    ps1Path ??
    (opts?.outDir ? join(opts.outDir, 'claude-code-policy.ps1') : undefined)
  const resolvedPsm =
    psmPath ??
    (opts?.outDir ? join(opts.outDir, 'claude-code-policy.psm1') : undefined)

  for (const [target, content] of [
    [resolvedPs1, buildPolicyExports(policy)],
    [resolvedPsm, buildPolicyModule(policy)],
  ] as const) {
    if (!target) continue
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      written.push(target)
    } catch (error) {
      logForDebugging(
        `[policy] failed to write policy helper file ${target}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return written
}
