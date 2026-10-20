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
  // R2 (Q4-2): refuse face plumbing — non-supported platform / pinned-but-
  // missing sandbox make the shared decision surface refuse.
  platformSupported: true,
  unavailableReason: undefined as string | undefined,
}

// Mirrors areUnsandboxedCommandsAllowedIn / isStrictSandboxModeConfiguredIn
// (sandboxDecision.ts) so the mock behaves like the real adapter would for
// these flags.
const sandboxManagerMock = {
  initialize: async () => {},
  // Mirrors the real adapter: sandboxing folds in platform support + the
  // pinned-but-unavailable availability error.
  isSandboxingEnabled: () =>
    sandboxState.enabled &&
    sandboxState.platformSupported &&
    sandboxState.unavailableReason === undefined,
  isSandboxEnabledInSettings: () => sandboxState.enabled,
  isSupportedPlatform: () => sandboxState.platformSupported,
  isPlatformInEnabledList: () => true,
  getSandboxUnavailableReason: () => sandboxState.unavailableReason,
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

const { evaluateSandboxDecisionForPowerShell, shouldUseSandboxForPowerShell } =
  await import('../sandboxDecision.js')

beforeEach(() => {
  sandboxState.enabled = false
  sandboxState.strictSandboxMode = false
  sandboxState.allowUnsandboxedCommands = true
  sandboxState.unsandboxedCommandsDisabled = false
  sandboxState.excludedCommands = []
  sandboxState.platformSupported = true
  sandboxState.unavailableReason = undefined
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

describe('evaluateSandboxDecisionForPowerShell refuse face (R2 #0051)', () => {
  test('strict + unavailable sandbox → refuse (three-state, not a silent bare run)', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    sandboxState.platformSupported = false
    expect(
      evaluateSandboxDecisionForPowerShell({ command: 'Write-Host hi' }),
    ).toEqual({ mode: 'refuse', reason: 'sandbox_unavailable' })
    // The boolean view maps refuse to false (the caller must ingest the
    // decision object itself to surface the tool error).
    expect(shouldUseSandboxForPowerShell({ command: 'Write-Host hi' })).toBe(
      false,
    )
  })

  test('strict opt-out with unavailable sandbox → refuse, same as Bash (unified surface)', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    sandboxState.platformSupported = false
    // The strict force-sandbox short-circuit is gone: PowerShell delegates to
    // the shared three-state surface, so the same strict+opt-out+unavailable
    // input that refuses on Bash (`refuse sandbox_unavailable`, official
    // validateInput rejects and does not exempt the model opt-out, 0051:731)
    // refuses here too instead of silently forcing the sandbox branch.
    expect(
      evaluateSandboxDecisionForPowerShell({
        command: 'Write-Host hi',
        dangerouslyDisableSandbox: true,
      }),
    ).toEqual({ mode: 'refuse', reason: 'sandbox_unavailable' })
  })

  test('item 8: sandbox not enabled in settings → never refuses, even unavailable', () => {
    sandboxState.enabled = false
    sandboxState.strictSandboxMode = true
    sandboxState.platformSupported = false
    // Official tn(0051:729) `!ze.isSandboxEnabledInSettings()` → null: a
    // globally disabled sandbox is plain non-enforcement, so the shared
    // decision surface falls through to the unsandboxed path instead of
    // refusing (the refuse face requires the enabled precondition).
    expect(
      evaluateSandboxDecisionForPowerShell({
        command: 'Write-Host hi',
        dangerouslyDisableSandbox: true,
      }),
    ).toEqual({ mode: 'unsandboxed' })
  })

  test('non-strict + unavailable sandbox stays fail-open unsandboxed', () => {
    sandboxState.enabled = true
    sandboxState.platformSupported = false
    expect(
      evaluateSandboxDecisionForPowerShell({ command: 'Write-Host hi' }),
    ).toEqual({ mode: 'unsandboxed' })
  })
})
