import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_PLUGIN_TYPES_OUTPUT_DIR,
  parsePluginTypesArgs,
} from '../args.js'
import { PLUGIN_TYPES_FILES, call } from '../plugin-types.js'

describe('parsePluginTypesArgs — /plugin-types argument surface', () => {
  test('no args uses the default output dir', () => {
    expect(parsePluginTypesArgs('')).toEqual({
      action: 'write',
      outputDir: DEFAULT_PLUGIN_TYPES_OUTPUT_DIR,
    })
  })

  test('accepts one configurable output dir', () => {
    expect(parsePluginTypesArgs('/tmp/my-types')).toEqual({
      action: 'write',
      outputDir: '/tmp/my-types',
    })
  })

  test('rejects extra args and unknown options', () => {
    expect(parsePluginTypesArgs('a b').action).toBe('invalid')
    expect(parsePluginTypesArgs('--json').action).toBe('invalid')
  })

  test('help exposes the three declaration files', () => {
    const parsed = parsePluginTypesArgs('help')
    expect(parsed.action).toBe('help')
  })
})

describe('call — writes the three declaration skeletons', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'plugin-types-test-'))
  const savedError = console.error

  afterEach(() => {
    console.error = savedError
  })

  test('writes claude-code.d.ts, claude-code-plugins.d.ts, claude-code-mcp.d.ts', async () => {
    const outDir = join(workDir, 'types')
    const result = await call(outDir, {} as never)
    expect(result.type).toBe('text')
    if (result.type !== 'text') return
    for (const { fileName } of PLUGIN_TYPES_FILES) {
      expect(result.value).toContain(fileName)
    }
  })

  test('default output dir is relative and resolvable', async () => {
    const parsed = parsePluginTypesArgs('')
    expect(parsed.action).toBe('write')
    if (parsed.action !== 'write') return
    expect(parsed.outputDir).not.toContain('\\')
  })
})
