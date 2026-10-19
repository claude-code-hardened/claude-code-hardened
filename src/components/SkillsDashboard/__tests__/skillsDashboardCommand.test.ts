import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'
import type { LocalJSXCommandContext } from '../../../commands.js'
import type { LocalJSXCommandOnDone } from '../../../types/command.js'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
// SKILLS_SYNC gate default OFF — the shell must render with zero cloud deps.
mock.module('bun:bundle', () => ({ feature: () => false }))

const skillsDashboard = (await import('../index.js')).default
const { call } = await import('../skills-dashboard.js')
const { SkillsDashboard } = await import('../SkillsDashboard.js')

describe('skills-dashboard registration entry', () => {
  test('exposes a local-jsx Command definition', () => {
    expect(skillsDashboard.type).toBe('local-jsx')
    expect(skillsDashboard.name).toBe('skills-dashboard')
    expect(typeof skillsDashboard.load).toBe('function')
  })

  test('load() resolves a module with a callable shell', async () => {
    const mod = await skillsDashboard.load()
    expect(typeof mod.call).toBe('function')
  })

  test('call() renders the SkillsDashboard element', async () => {
    const node = await call(
      (() => {}) as unknown as LocalJSXCommandOnDone,
      {} as unknown as LocalJSXCommandContext,
    )
    expect(React.isValidElement(node)).toBe(true)
    expect((node as React.ReactElement).type).toBe(SkillsDashboard)
  })
})
