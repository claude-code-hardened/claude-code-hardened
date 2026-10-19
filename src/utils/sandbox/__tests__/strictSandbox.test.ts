/**
 * W4 (#55) — sandbox strict-mode decision predicate tests.
 *
 * Exercises the pure sandboxDecision.ts module — the real code that
 * sandbox-adapter.ts delegates to for its decision surface (the
 * unsandboxedCommandsDisabled short-circuit, the strict-mode flag and the
 * escape-hatch interplay). The BashTool composes these through shouldUseSandbox;
 * that gate is covered in shouldUseSandbox.test.ts next to BashTool.
 */
import { describe, expect, test } from 'bun:test'
import {
  areUnsandboxedCommandsAllowedIn,
  areUnsandboxedCommandsDisabledIn,
  isStrictSandboxModeConfiguredIn,
} from '../sandboxDecision.js'

describe('sandbox decision predicates (W4)', () => {
  test('unsandboxed commands allowed by default', () => {
    expect(areUnsandboxedCommandsAllowedIn({})).toBe(true)
    expect(areUnsandboxedCommandsAllowedIn({ sandbox: {} })).toBe(true)
    expect(areUnsandboxedCommandsAllowedIn(undefined)).toBe(true)
  })

  test('allowUnsandboxedCommands: false closes the escape hatch', () => {
    expect(
      areUnsandboxedCommandsAllowedIn({
        sandbox: { allowUnsandboxedCommands: false },
      }),
    ).toBe(false)
  })

  test('unsandboxedCommandsDisabled short-circuits even when allowed', () => {
    const settings = {
      sandbox: {
        allowUnsandboxedCommands: true,
        unsandboxedCommandsDisabled: true,
      },
    }
    expect(areUnsandboxedCommandsAllowedIn(settings)).toBe(false)
    expect(areUnsandboxedCommandsDisabledIn(settings)).toBe(true)
  })

  test('areUnsandboxedCommandsDisabled mirrors the allowed predicate', () => {
    expect(areUnsandboxedCommandsDisabledIn({})).toBe(false)
    expect(
      areUnsandboxedCommandsDisabledIn({
        sandbox: { allowUnsandboxedCommands: false },
      }),
    ).toBe(true)
  })

  test('strict mode flag defaults to false and reads through', () => {
    expect(isStrictSandboxModeConfiguredIn({})).toBe(false)
    expect(isStrictSandboxModeConfiguredIn(undefined)).toBe(false)
    expect(
      isStrictSandboxModeConfiguredIn({ sandbox: { strictSandboxMode: true } }),
    ).toBe(true)
    expect(
      isStrictSandboxModeConfiguredIn({
        sandbox: { strictSandboxMode: false },
      }),
    ).toBe(false)
  })
})
