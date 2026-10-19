import { describe, expect, test } from 'bun:test'
import {
  applyAliasesToInputText,
  expandMessage,
  loadAliasMap,
} from '../../../hooks/aliasExpansion.js'
import { parseAliasDefinition, parseAliasArgs } from '../args.js'

describe('parseAliasArgs — /alias argument surface', () => {
  test('no args means list', () => {
    expect(parseAliasArgs('')).toEqual({ action: 'list' })
  })

  test('create parses name=value definitions', () => {
    expect(parseAliasArgs('ci=review:audit CI first')).toEqual({
      action: 'create',
      name: 'ci',
      target: 'review:audit CI first',
    })
  })

  test('rejects malformed definitions', () => {
    expect(parseAliasArgs('=target').action).toBe('invalid')
    expect(parseAliasArgs('name=').action).toBe('invalid')
    expect(parseAliasArgs('a b c').action).toBe('invalid')
  })

  test('delete via -d or word form', () => {
    expect(parseAliasArgs('-d ci')).toEqual({ action: 'delete', name: 'ci' })
    expect(parseAliasArgs('delete ci')).toEqual({
      action: 'delete',
      name: 'ci',
    })
    expect(parseAliasArgs('-d').action).toBe('invalid')
  })
})

describe('parseAliasDefinition — name=value rule', () => {
  test('matches the anchored parameter shape', () => {
    expect(parseAliasDefinition('name=value')).toEqual({
      ok: true,
      name: 'name',
      target: 'value',
    })
    expect(parseAliasDefinition('bad').ok).toBe(false)
  })
})

describe('alias expansion hook point', () => {
  test('expands the leading alias token and keeps the arg tail', () => {
    const map = { ci: { target: 'review:check CI', created: '' } }
    expect(expandMessage('/ci now', map)).toBe('/review:check CI now')
    expect(expandMessage('/ci', map)).toBe('/review:check CI')
  })

  test('passes through unknown and non-slash input', () => {
    const map = loadAliasMap()
    expect(expandMessage('/unset-alias', map)).toBe('/unset-alias')
    expect(expandMessage('hello', map)).toBe('hello')
    expect(applyAliasesToInputText('plain text', map)).toBe('plain text')
  })
})
