/**
 * W3 task #54 — /alias argument parser. Pure module.
 */

export type AliasArgs =
  | { action: 'list' }
  | { action: 'create'; name: string; target: string }
  | { action: 'delete'; name: string }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const ALIAS_USAGE = [
  'Usage: /alias [name=value | -d name | list]',
  '',
  '  (no args)  List saved aliases',
  '  name=value Create/update alias so "/name ..." forwards to "/value ..."',
  '  -d name    Delete an alias (also: delete <name>)',
].join('\n')

export function parseAliasDefinition(
  token: string,
): { ok: true; name: string; target: string } | { ok: false; error: string } {
  const eq = token.indexOf('=')
  if (eq <= 0 || eq === token.length - 1) {
    return {
      ok: false,
      error: 'Alias definition must be in the form name=value',
    }
  }
  const name = token.slice(0, eq).trim()
  const target = token.slice(eq + 1).trim()
  if (!name || !target) {
    return {
      ok: false,
      error: 'Alias definition must be in the form name=value',
    }
  }
  if (/\s/.test(name)) {
    return { ok: false, error: 'Alias name must not contain whitespace' }
  }
  if (name.startsWith('-')) {
    return { ok: false, error: 'Alias name must not start with "-"' }
  }
  return { ok: true, name, target }
}

export function parseAliasArgs(raw: string): AliasArgs {
  const trimmed = raw.trim()
  if (trimmed === '') return { action: 'list' }
  if (trimmed === 'help') return { action: 'help' }
  if (trimmed.startsWith('-d ')) {
    const name = trimmed.slice(3).trim()
    if (!name) return { action: 'invalid', error: 'Missing alias name' }
    return { action: 'delete', name }
  }
  const [head, ...rest] = trimmed.split(/\s+/)
  if (head === 'delete') {
    if (rest.length !== 1) {
      return { action: 'invalid', error: 'Usage: /alias delete <name>' }
    }
    return { action: 'delete', name: rest[0] }
  }
  if (head === 'list') {
    if (rest.length > 0) {
      return { action: 'invalid', error: `Unexpected argument: "${rest[0]}"` }
    }
    return { action: 'list' }
  }
  // A definition consumes the full arg tail: targets may contain spaces
  // (e.g. "ci=review:audit the CI config first" forwards to that whole line).
  const parsed = parseAliasDefinition(trimmed)
  if (!parsed.ok) {
    return { action: 'invalid', error: parsed.error }
  }
  return { action: 'create', name: parsed.name, target: parsed.target }
}
