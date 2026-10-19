/**
 * W3 task #54 — /alias: create or list command aliases.
 *
 * Aliases are persisted locally (aliases.json under the Claude config home)
 * and are session-portable. Expansion is wired into the real input pipeline:
 * `processUserInputBase` applies `applyAliasesToInputText`
 * (src/hooks/aliasExpansion.ts) to slash input before slash dispatch, so
 * `/<alias> ...` actually forwards to the target command.
 */

import type { LocalCommandCall } from '../../types/command.js'
import { ALIAS_USAGE, parseAliasArgs } from './args.js'
import {
  defineAlias,
  getAliasStorePath,
  loadAliasMap,
  removeAlias,
} from '../../hooks/aliasExpansion.js'

export function formatAliasList(): string {
  const map = loadAliasMap()
  const names = Object.keys(map).sort()
  if (names.length === 0) {
    return [
      'No aliases defined.',
      '',
      'Create one: /alias ci=review:audit the CI config first',
    ].join('\n')
  }
  const lines = names.map(name => `  /${name}  →  /${map[name]!.target}`)
  return ['Aliases:', ...lines, '', `Storage: ${getAliasStorePath()}`].join(
    '\n',
  )
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parseAliasArgs(rawArgs)
  switch (args.action) {
    case 'list':
      return { type: 'text', value: formatAliasList() }
    case 'create':
      defineAlias(args.name, args.target)
      return {
        type: 'text',
        value: [
          `Alias saved: /${args.name} → /${args.target}`,
          '',
          'Typing /<alias> ... now expands to the target command (with the',
          'typed tail preserved) before slash dispatch, via the input',
          'pipeline hook applyAliasesToInputText. Aliases you define win',
          'over builtin command names. Remove with: /alias -d <name>',
        ].join('\n'),
      }
    case 'delete': {
      const removed = removeAlias(args.name)
      return {
        type: 'text',
        value: removed
          ? `Alias removed: ${args.name}`
          : `No alias named "${args.name}".`,
      }
    }
    case 'help':
      return { type: 'text', value: ALIAS_USAGE }
    case 'invalid':
      return { type: 'text', value: [args.error, '', ALIAS_USAGE].join('\n') }
  }
}
