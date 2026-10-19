/**
 * W3 task #54 — /auto-mode-setup argument parser. Pure module.
 *
 * Parses the official parameter surface (--request-id, --wizard posture=…,
 * --propose, --expect-sha256, --apply-file) so those invocations are
 * recognized instead of rejected as unknown. The parser never executes
 * them: it tags the invocation as `unsupported` and the command answers
 * with an explicit "not supported in this build" message. Only the plain
 * enable/disable/status boolean flow executes.
 */

export type AutoModeSetupArgs =
  | { action: 'status' }
  | { action: 'enable' }
  | { action: 'disable' }
  | { action: 'help' }
  | { action: 'invalid'; error: string }
  | {
      action: 'unsupported'
      /** Human-readable labels of the official flags present in the invocation. */
      flags: string[]
    }

/** Canonical display label per official flag. */
const FLAG_LABELS: Record<string, string> = {
  '--request-id': '--request-id <id>',
  '--wizard': '--wizard posture=<posture>',
  '--propose': '--propose',
  '--expect-sha256': '--expect-sha256 <sha256>',
  '--apply-file': '--apply-file <path>',
}

/** Official flags that take a value (inline `--flag=v` or next token). */
const VALUE_FLAGS = new Set(['--request-id', '--expect-sha256', '--apply-file'])

export const AUTO_MODE_SETUP_USAGE = [
  'Usage: /auto-mode-setup [enable | disable | status]',
  '',
  '  (no args)  Show the agent auto-mode setup status',
  '  enable     Record that auto mode has been set up on this machine',
  '  disable    Clear the auto-mode setup marker',
  '  status     Show the setup marker and its location',
  '',
  'The official flags --request-id, --wizard posture=…, --propose,',
  '--expect-sha256 and --apply-file are parsed but not supported in',
  'this build; the command says so instead of pretending to run them.',
].join('\n')

export function parseAutoModeSetupArgs(raw: string): AutoModeSetupArgs {
  const tokens = raw.split(/\s+/).filter(Boolean)
  const flags: string[] = []
  let positional: { sub: string; token: string } | null = null

  const addFlag = (name: string): void => {
    if (!flags.includes(FLAG_LABELS[name])) flags.push(FLAG_LABELS[name])
  }

  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      const base = eq === -1 ? token : token.slice(0, eq)
      if (!(base in FLAG_LABELS)) {
        return { action: 'invalid', error: `Unknown option: "${token}"` }
      }
      if (base === '--propose') {
        if (eq !== -1) {
          return { action: 'invalid', error: `Unknown option: "${token}"` }
        }
        addFlag(base)
        index += 1
        continue
      }
      if (base === '--wizard') {
        // Official form: --wizard posture=<posture> (value in the next token).
        const next = tokens[index + 1]
        if (eq === -1 && next !== undefined && next.startsWith('posture=')) {
          addFlag(base)
          index += 2
          continue
        }
        return {
          action: 'invalid',
          error:
            '--wizard requires a posture=… value (e.g. --wizard posture=always)',
        }
      }
      // Generic value flags: accept --flag=value or --flag value.
      if (eq !== -1) {
        if (token.slice(eq + 1) === '') {
          return { action: 'invalid', error: `${base} requires a value` }
        }
        addFlag(base)
        index += 1
        continue
      }
      const next = tokens[index + 1]
      if (next === undefined) {
        return { action: 'invalid', error: `${base} requires a value` }
      }
      addFlag(base)
      index += 2
      continue
    }

    const sub = token.toLowerCase()
    if (positional === null) {
      if (
        sub === 'status' ||
        sub === 'enable' ||
        sub === 'disable' ||
        sub === 'help'
      ) {
        positional = { sub, token }
      } else {
        return { action: 'invalid', error: `Unknown subcommand: "${token}"` }
      }
    } else {
      return { action: 'invalid', error: `Unknown subcommand: "${token}"` }
    }
    index += 1
  }

  if (flags.length > 0) return { action: 'unsupported', flags }
  switch (positional?.sub) {
    case 'enable':
      return { action: 'enable' }
    case 'disable':
      return { action: 'disable' }
    case 'help':
      return { action: 'help' }
    default:
      // '' and explicit 'status' both mean status.
      return { action: 'status' }
  }
}
