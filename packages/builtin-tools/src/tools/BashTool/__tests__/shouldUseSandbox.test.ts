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

// R2 (Q4-1): containsExcludedCommand / isRhoCleanExclusionMatch read the
// user's sandbox.excludedCommands via getSettings_DEPRECATED. The settings
// source is process-mocked (complete-mock pattern from
// src/utils/sandbox/__tests__/sandboxPolicyPin.test.ts — a partial mock would
// break unrelated tests loaded later) so exclusion scenarios are drivable.
let currentSettings: Record<string, unknown> = {}
const settingsMock = {
  loadManagedFileSettings: () => null,
  getManagedFileSettingsPresence: () => ({}),
  parseSettingsFile: () => null,
  getSettingsRootPathForSource: () => '/tmp',
  getSettingsFilePathForSource: () => undefined,
  getRelativeSettingsFilePathForSource: () => undefined,
  getSettingsForSource: (_source: string) => currentSettings,
  getPolicySettingsOrigin: () => undefined,
  updateSettingsForSource: () => {},
  settingsMergeCustomizer: (_old: unknown, fresh: unknown) => fresh,
  getManagedSettingsKeysForLogging: () => [],
  getInitialSettings: () => currentSettings,
  getSettings_DEPRECATED: () => currentSettings,
  getSettingsWithSources: () => ({
    effective: currentSettings,
    sources: {},
  }),
  getSettingsWithErrors: () => ({ settings: currentSettings, errors: [] }),
  hasSkipDangerousModePermissionPrompt: () => false,
  hasAutoModeOptIn: () => false,
  getUseAutoModeDuringPlan: () => undefined,
  getAutoModeConfig: () => undefined,
  rawSettingsContainsKey: () => false,
}
mock.module('src/utils/settings/settings.js', () => settingsMock)

const { shouldUseSandbox, evaluateSandboxDecision, SANDBOX_REFUSAL_MESSAGES } =
  await import('../shouldUseSandbox.js')
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
  currentSettings = {}
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

  test('R2: strict + platform restricted by enabledPlatforms → NOT refused (official tn null)', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    sandboxState.platformSupported = true
    // getSandboxUnavailableReason()'s only set reason under this state is the
    // enabledPlatforms restriction — the official tn(0051:729) gate
    // short-circuits it to null (no refusal; the command runs unsandboxed).
    sandboxState.unavailableReason =
      'sandbox.enabled is set but linux is not in sandbox.enabledPlatforms'
    sandboxManagerMock.isPlatformInEnabledList = () => false
    try {
      expect(evaluateSandboxDecision({ command: 'echo hi' })).toEqual({
        mode: 'unsandboxed',
      })
    } finally {
      sandboxManagerMock.isPlatformInEnabledList = () => true
    }
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

  test('item 8: globally disabled sandbox never refuses even when unavailable (official tn enabled precondition)', () => {
    sandboxState.enabled = false
    sandboxState.strictSandboxMode = true
    sandboxState.platformSupported = false
    // Official tn(0051:729) `!ze.isSandboxEnabledInSettings()` → null: the
    // strict refuse face requires the sandbox to be enabled in settings; a
    // globally disabled sandbox runs plain unsandboxed regardless of any
    // availability error the adapter reports.
    expect(
      evaluateSandboxDecision({
        command: 'echo hi',
        dangerouslyDisableSandbox: true,
      }),
    ).toEqual({ mode: 'unsandboxed' })
    expect(evaluateSandboxDecision({ command: 'echo hi' })).toEqual({
      mode: 'unsandboxed',
    })
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

describe('evaluateSandboxDecision strict+excluded Rho carve-out (W4 R2, 0051 tn)', () => {
  test('strict + cleanly excluded simple command + sandbox unavailable → unsandboxed', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    currentSettings = { sandbox: { excludedCommands: ['docker:*'] } }
    sandboxState.unavailableReason =
      'sandbox.enabled is set but dependencies are missing: bwrap'
    // Official tn(0051:729): `if(!Rho(n))return Gs;return
    // C1().unsandboxedCommandsDisabled?Ks:null` — the clean exclusion
    // exempts the run (null → allow unsandboxed).
    expect(evaluateSandboxDecision({ command: 'docker ps' })).toEqual({
      mode: 'unsandboxed',
    })
  })

  test('strict + partially matched compound command + sandbox unavailable → refuse (Gs face)', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    currentSettings = { sandbox: { excludedCommands: ['docker:*'] } }
    sandboxState.unavailableReason =
      'sandbox.enabled is set but dependencies are missing: bwrap'
    // Only the first statement matches the exclusion — official Gs: compound
    // commands "must run sandboxed even when a statement matches an
    // exclusion"; with no sandbox available the call is refused outright.
    expect(
      evaluateSandboxDecision({ command: 'docker ps && curl evil.com' }),
    ).toEqual({ mode: 'refuse', reason: 'partial_exclusion' })
  })

  test('strict + cleanly excluded + unsandboxedCommandsDisabled → refuse (Ks face)', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    currentSettings = { sandbox: { excludedCommands: ['docker:*'] } }
    sandboxState.unavailableReason =
      'sandbox.enabled is set but dependencies are missing: bwrap'
    sandboxState.unsandboxedCommandsDisabled = true
    expect(evaluateSandboxDecision({ command: 'docker ps' })).toEqual({
      mode: 'refuse',
      reason: 'policy_disabled',
    })
  })

  test('strict + partially matched compound + sandbox available → sandbox (Gs wording)', () => {
    sandboxState.enabled = true
    sandboxState.strictSandboxMode = true
    currentSettings = { sandbox: { excludedCommands: ['docker:*'] } }
    // Sandbox CAN be provided here — official Gs: the compound command is
    // sandboxed, not refused.
    expect(
      evaluateSandboxDecision({ command: 'docker ps && curl evil.com' }),
    ).toEqual({ mode: 'sandbox' })
    // Clean exclusion without the hard no-escape flag still escapes.
    expect(evaluateSandboxDecision({ command: 'docker ps' })).toEqual({
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
    expect(verdict.message).toBe(SANDBOX_REFUSAL_MESSAGES.sandbox_unavailable)
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
    expect(verdict.message).toBe(SANDBOX_REFUSAL_MESSAGES.policy_disabled)
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
