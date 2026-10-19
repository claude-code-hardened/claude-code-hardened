/**
 * R4 (#0051) — PowerShell strict-gate tests.
 *
 * The gate composes SandboxManager decision predicates; the adapter is
 * process-mocked with the full ISandboxManager surface (same pattern as
 * BashTool's shouldUseSandbox.test.ts — no other test file in this directory
 * imports it for real, so the mock cannot leak). The predicate logic itself
 * is covered by src/utils/sandbox/__tests__/strictSandbox.test.ts.
 */
import { beforeEach, describe, expect, test, mock } from 'bun:test'

const sandboxState = {
  enabled: false,
  strictSandboxMode: false,
  allowUnsandboxedCommands: true,
  unsandboxedCommandsDisabled: false,
  excludedCommands: [] as string[],
}

// Mirrors areUnsandboxedCommandsAllowedIn / isStrictSandboxModeConfiguredIn
// (sandboxDecision.ts) so the mock behaves like the real adapter would for
// these flags.
const sandboxManagerMock = {
  initialize: async () => {},
  isSandboxingEnabled: () => sandboxState.enabled,
  isSandboxEnabledInSettings: () => sandboxState.enabled,
  isSupportedPlatform: () => true,
  isPlatformInEnabledList: () => true,
  getSandboxUnavailableReason: () => undefined,
  checkDependencies: () => ({ errors: [], warnings: [] }),
  isAutoAllowBashIfSandboxedEnabled: () => true,
  areUnsandboxedCommandsAllowed: () => {
    if (sandboxState.unsandboxedCommandsDisabled) return false
    return sandboxState.allowUnsandboxedCommands
  },
  isStrictSandboxModeConfigured: () => sandboxState.strictSandboxMode,
  areUnsandboxedCommandsDisabled: () =>
    !(
      !sandboxState.unsandboxedCommandsDisabled &&
      sandboxState.allowUnsandboxedCommands
    ),
  isSandboxRequired: () => sandboxState.enabled,
  areSandboxSettingsLockedByPolicy: () => false,
  setSandboxSettings: async () => {},
  getFsReadConfig: () => ({ denyRead: [], allowRead: [] }),
  getFsWriteConfig: () => ({ allowWrite: [], denyWrite: [] }),
  getNetworkRestrictionConfig: () => ({
    allowedDomains: [],
    deniedDomains: [],
  }),
  getAllowUnixSockets: () => undefined,
  getAllowLocalBinding: () => undefined,
  getIgnoreViolations: () => undefined,
  getEnableWeakerNestedSandbox: () => undefined,
  getExcludedCommands: () => sandboxState.excludedCommands,
  getProxyPort: () => undefined,
  getSocksProxyPort: () => undefined,
  getLinuxHttpSocketPath: () => undefined,
  getLinuxSocksSocketPath: () => undefined,
  waitForNetworkInitialization: async () => true,
  wrapWithSandbox: async (command: string) => command,
  cleanupAfterCommand: () => {},
  getSandboxViolationStore: () => ({}),
  annotateStderrWithSandboxFailures: (_command: string, stderr: string) =>
    stderr,
  getLinuxGlobPatternWarnings: () => [],
  refreshConfig: () => {},
  reset: async () => {},
}

mock.module('src/utils/sandbox/sandbox-adapter.js', () => ({
  SandboxManager: sandboxManagerMock,
}))

const { shouldUseSandboxForPowerShell } = await import('../sandboxDecision.js')

beforeEach(() => {
  sandboxState.enabled = false
  sandboxState.strictSandboxMode = false
  sandboxState.allowUnsandboxedCommands = true
  sandboxState.unsandboxedCommandsDisabled = false
  sandboxState.excludedCommands = []
})

describe('shouldUseSandboxForPowerShell strict gate (R4)', () => {
  test('strict mode forces the sandbox despite dangerouslyDisableSandbox', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    sandboxState.allowUnsandboxedCommands = true
    // The model's opt-out is refused: the sandbox branch is taken anyway.
    expect(
      shouldUseSandboxForPowerShell({
        command: 'Remove-Item /tmp/x',
        dangerouslyDisableSandbox: true,
      }),
    ).toBe(true)
    // Even a plain command keeps flowing through the sandbox.
    expect(shouldUseSandboxForPowerShell({ command: 'Write-Host hi' })).toBe(
      true,
    )
  })

  test('strict mode keeps the gate closed even with an open hatch', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    expect(
      shouldUseSandboxForPowerShell({
        command: 'Write-Host hi',
        dangerouslyDisableSandbox: true,
      }),
    ).toBe(true)
  })

  test('without strict mode, an allowed opt-out escapes the sandbox', () => {
    sandboxState.enabled = true
    sandboxState.allowUnsandboxedCommands = true
    expect(
      shouldUseSandboxForPowerShell({
        command: 'Write-Host hi',
        dangerouslyDisableSandbox: true,
      }),
    ).toBe(false)
  })

  test('plain commands run sandboxed when sandboxing is on', () => {
    sandboxState.enabled = true
    expect(shouldUseSandboxForPowerShell({ command: 'Write-Host hi' })).toBe(
      true,
    )
    expect(shouldUseSandboxForPowerShell({})).toBe(false) // no command → nothing to sandbox
  })
})
