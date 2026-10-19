/**
 * W4 (#55) — shouldUseSandbox strict-gate tests.
 *
 * The gate composes SandboxManager decision predicates; the adapter is
 * process-mocked with the full ISandboxManager surface (no other test file in
 * this directory imports it for real, so the mock cannot leak). The predicate
 * logic itself is covered by src/utils/sandbox/__tests__/strictSandbox.test.ts.
 */
import { beforeEach, describe, expect, test, mock } from 'bun:test'

const sandboxState = {
  enabled: false,
  strictSandboxMode: false,
  allowUnsandboxedCommands: true,
  unsandboxedCommandsDisabled: false,
  excludedCommands: [] as string[],
  // R4 (evaluateSandboxDecision): a non-undefined availability error means
  // sandbox.enabled=true was pinned but the sandbox cannot actually run
  // (missing deps / platform not in enabledPlatforms).
  unavailableReason: undefined as string | undefined,
  platformSupported: true,
}

// Mirrors areUnsandboxedCommandsAllowedIn / isStrictSandboxModeConfiguredIn
// (sandboxDecision.ts) so the mock behaves like the real adapter would for
// these flags.
const sandboxManagerMock = {
  initialize: async () => {},
  isSandboxingEnabled: () =>
    sandboxState.enabled &&
    sandboxState.unavailableReason === undefined &&
    sandboxState.platformSupported,
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

const { shouldUseSandbox, evaluateSandboxDecision } = await import(
  '../shouldUseSandbox.js'
)
// Same-process binding: BashTool.tsx reuses the already-mocked adapter via
// shouldUseSandbox.js, so validateInput's refuse face is driven by the same
// sandboxState as the decision tests above.
const { BashTool } = await import('../BashTool.js')

beforeEach(() => {
  sandboxState.enabled = false
  sandboxState.strictSandboxMode = false
  sandboxState.allowUnsandboxedCommands = true
  sandboxState.unsandboxedCommandsDisabled = false
  sandboxState.excludedCommands = []
  sandboxState.unavailableReason = undefined
  sandboxState.platformSupported = true
})

describe('shouldUseSandbox strict gate (W4)', () => {
  test('returns false when sandboxing is disabled outright', () => {
    expect(shouldUseSandbox({ command: 'echo hi' })).toBe(false)
    expect(
      shouldUseSandbox({ command: 'echo hi', dangerouslyDisableSandbox: true }),
    ).toBe(false)
  })

  test('strict mode forces the sandbox despite dangerouslyDisableSandbox', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    sandboxState.allowUnsandboxedCommands = true
    expect(
      shouldUseSandbox({ command: 'echo hi', dangerouslyDisableSandbox: true }),
    ).toBe(true)
  })

  test('strict mode keeps the sandbox closed even when the hatch is disabled', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    sandboxState.unsandboxedCommandsDisabled = true
    expect(
      shouldUseSandbox({ command: 'echo hi', dangerouslyDisableSandbox: true }),
    ).toBe(true)
  })

  test('without strict mode, an allowed opt-out escapes the sandbox', () => {
    sandboxState.enabled = true
    sandboxState.allowUnsandboxedCommands = true
    expect(
      shouldUseSandbox({ command: 'echo hi', dangerouslyDisableSandbox: true }),
    ).toBe(false)
  })

  test('closed hatch forces the sandbox even without strict mode', () => {
    sandboxState.enabled = true
    sandboxState.allowUnsandboxedCommands = false
    expect(
      shouldUseSandbox({ command: 'echo hi', dangerouslyDisableSandbox: true }),
    ).toBe(true)
  })

  test('plain commands run sandboxed when sandboxing is on', () => {
    sandboxState.enabled = true
    expect(shouldUseSandbox({ command: 'echo hi' })).toBe(true)
    expect(shouldUseSandbox({})).toBe(false) // no command → nothing to sandbox
  })
})

describe('evaluateSandboxDecision refuse face (W4 R4)', () => {
  test('strict mode + sandbox unavailable → refuse (opt-out and plain)', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    sandboxState.unavailableReason =
      'sandbox.enabled is set but dependencies are missing: bwrap'
    sandboxState.platformSupported = true
    expect(
      evaluateSandboxDecision({
        command: 'echo hi',
        dangerouslyDisableSandbox: true,
      }),
    ).toEqual({ mode: 'refuse', reason: 'sandbox_unavailable' })
    // Even without an opt-out attempt: under strict policy nothing runs
    // bare-metal while the sandbox is down.
    expect(evaluateSandboxDecision({ command: 'echo hi' })).toEqual({
      mode: 'refuse',
      reason: 'sandbox_unavailable',
    })
  })

  test('strict mode + unsupported platform → refuse', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    sandboxState.platformSupported = false
    expect(evaluateSandboxDecision({ command: 'echo hi' })).toEqual({
      mode: 'refuse',
      reason: 'sandbox_unavailable',
    })
  })

  test('strict mode + sandbox available → sandbox', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    expect(evaluateSandboxDecision({ command: 'echo hi' })).toEqual({
      mode: 'sandbox',
    })
    expect(
      evaluateSandboxDecision({
        command: 'echo hi',
        dangerouslyDisableSandbox: true,
      }),
    ).toEqual({ mode: 'sandbox' })
  })

  test('closed hatch + opt-out + sandbox unavailable → refuse (policy_disabled)', () => {
    sandboxState.enabled = true
    sandboxState.unsandboxedCommandsDisabled = true
    sandboxState.unavailableReason =
      'sandbox.enabled is set but WSL1 is not supported'
    expect(
      evaluateSandboxDecision({
        command: 'echo hi',
        dangerouslyDisableSandbox: true,
      }),
    ).toEqual({ mode: 'refuse', reason: 'policy_disabled' })
  })

  test('globally disabled sandbox (no availability error) never refuses', () => {
    sandboxState.enabled = false
    sandboxState.strictSandboxMode = true
    sandboxState.unsandboxedCommandsDisabled = true
    // isSandboxingEnabled() false with getSandboxUnavailableReason()
    // undefined = plain non-enforcement, not an unavailable sandbox.
    expect(
      evaluateSandboxDecision({
        command: 'echo hi',
        dangerouslyDisableSandbox: true,
      }),
    ).toEqual({ mode: 'unsandboxed' })
  })

  test('non-strict decisions are unchanged', () => {
    sandboxState.enabled = true
    expect(evaluateSandboxDecision({ command: 'echo hi' })).toEqual({
      mode: 'sandbox',
    })
    expect(
      evaluateSandboxDecision({
        command: 'echo hi',
        dangerouslyDisableSandbox: true,
      }),
    ).toEqual({ mode: 'unsandboxed' })
    sandboxState.allowUnsandboxedCommands = false
    expect(
      evaluateSandboxDecision({
        command: 'echo hi',
        dangerouslyDisableSandbox: true,
      }),
    ).toEqual({ mode: 'sandbox' })
    // Unavailable sandbox without any policy hit: fail-open unchanged.
    sandboxState.allowUnsandboxedCommands = true
    sandboxState.unavailableReason =
      'sandbox.enabled is set but dependencies are missing'
    expect(evaluateSandboxDecision({ command: 'echo hi' })).toEqual({
      mode: 'unsandboxed',
    })
  })
})

describe('BashTool.validateInput refuse consumption (W4 R4)', () => {
  const validate = (input: Record<string, unknown>) =>
    BashTool.validateInput?.(input as never) as Promise<{
      result: boolean
      message?: string
    }>

  test('strict + unavailable sandbox → tool error, no bare run', async () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    sandboxState.unavailableReason =
      'sandbox.enabled is set but dependencies are missing'
    const verdict = await validate({ command: 'echo hi' })
    expect(verdict.result).toBe(false)
    expect(verdict.message).toBe(
      'sandbox unavailable under strict managed policy',
    )
  })

  test('closed hatch + unavailable sandbox + opt-out → policy error', async () => {
    sandboxState.enabled = true
    sandboxState.unsandboxedCommandsDisabled = true
    sandboxState.unavailableReason =
      'sandbox.enabled is set but WSL1 is not supported'
    const verdict = await validate({
      command: 'echo hi',
      dangerouslyDisableSandbox: true,
    })
    expect(verdict.result).toBe(false)
    expect(verdict.message).toBe('unsandboxed commands are disabled by policy')
  })

  test('healthy sandbox under strict → no refuse', async () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    const verdict = await validate({ command: 'echo hi' })
    expect(verdict.result).toBe(true)
  })

  test('globally disabled sandbox → no refuse (plain non-enforcement)', async () => {
    sandboxState.enabled = false
    sandboxState.strictSandboxMode = true
    sandboxState.unsandboxedCommandsDisabled = true
    const verdict = await validate({
      command: 'echo hi',
      dangerouslyDisableSandbox: true,
    })
    expect(verdict.result).toBe(true)
  })
})
