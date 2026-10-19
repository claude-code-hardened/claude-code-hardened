/**
 * W4 (#55) — tests for the policySettings read/validation layer.
 * The settings source is process-mocked; predicates are pure views over it.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log.js'
import { debugMock } from '../../../../tests/mocks/debug.js'

let currentPolicy: Record<string, unknown> | null = null

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
// Complete settings.js export set (mock.module is process-global; a partial
// mock would break unrelated tests loaded later that link real named exports).
const settingsMock = {
  loadManagedFileSettings: () => null,
  getManagedFileSettingsPresence: () => ({}),
  parseSettingsFile: () => null,
  getSettingsRootPathForSource: () => '/tmp',
  getSettingsFilePathForSource: () => undefined,
  getRelativeSettingsFilePathForSource: () => undefined,
  getSettingsForSource: (_source: string) => currentPolicy,
  getPolicySettingsOrigin: () => undefined,
  updateSettingsForSource: () => {},
  settingsMergeCustomizer: (_old: unknown, fresh: unknown) => fresh,
  getManagedSettingsKeysForLogging: () => [],
  getInitialSettings: () => currentPolicy ?? {},
  getSettings_DEPRECATED: () => currentPolicy ?? {},
  getSettingsWithSources: () => ({
    effective: currentPolicy ?? {},
    sources: {},
  }),
  getSettingsWithErrors: () => ({ settings: currentPolicy ?? {}, errors: [] }),
  hasSkipDangerousModePermissionPrompt: () => false,
  hasAutoModeOptIn: () => false,
  getUseAutoModeDuringPlan: () => undefined,
  getAutoModeConfig: () => undefined,
  rawSettingsContainsKey: () => false,
}
mock.module('src/utils/settings/settings.js', () => settingsMock)

const {
  getPolicySettings,
  isPolicyEnforced,
  isSandboxDecisionPolicyPinned,
  validatePolicyLayer,
} = await import('../policySettings.js')

beforeEach(() => {
  currentPolicy = null
})

describe('getPolicySettings / isPolicyEnforced', () => {
  test('returns null and not-enforced when the source is absent', () => {
    expect(getPolicySettings()).toBeNull()
    expect(isPolicyEnforced()).toBe(false)
  })

  test('passes through the raw policy shape when present', () => {
    currentPolicy = { sandbox: { enabled: true } }
    expect(getPolicySettings()).toEqual({ sandbox: { enabled: true } })
    expect(isPolicyEnforced()).toBe(true)
  })
})

describe('isSandboxDecisionPolicyPinned', () => {
  test('false without a policy layer', () => {
    expect(isSandboxDecisionPolicyPinned('enabled')).toBe(false)
  })

  test('true only for keys explicitly present in policy sandbox', () => {
    currentPolicy = { sandbox: { enabled: true, strictSandboxMode: false } }
    expect(isSandboxDecisionPolicyPinned('enabled')).toBe(true)
    expect(isSandboxDecisionPolicyPinned('strictSandboxMode')).toBe(true)
    expect(isSandboxDecisionPolicyPinned('allowUnsandboxedCommands')).toBe(
      false,
    )
    expect(isSandboxDecisionPolicyPinned('unsandboxedCommandsDisabled')).toBe(
      false,
    )
  })

  test('sandbox block with only autoAllowBashIfSandboxed pins nothing', () => {
    // Official double condition (tn 0051): a sandbox policy block that merely
    // carries unrelated knobs does not pin `enabled` (nor anything else).
    currentPolicy = { sandbox: { autoAllowBashIfSandboxed: true } }
    expect(isSandboxDecisionPolicyPinned('enabled')).toBe(false)
    expect(isSandboxDecisionPolicyPinned('strictSandboxMode')).toBe(false)
    expect(isSandboxDecisionPolicyPinned('allowUnsandboxedCommands')).toBe(
      false,
    )
    expect(isSandboxDecisionPolicyPinned('unsandboxedCommandsDisabled')).toBe(
      false,
    )
  })

  test('enabled is pinned only when its policy value is true', () => {
    currentPolicy = { sandbox: { enabled: true } }
    expect(isSandboxDecisionPolicyPinned('enabled')).toBe(true)
    currentPolicy = { sandbox: { enabled: false } }
    expect(isSandboxDecisionPolicyPinned('enabled')).toBe(false)
  })

  test('non-enabled keys pin on presence regardless of value', () => {
    currentPolicy = {
      sandbox: {
        enabled: false,
        strictSandboxMode: false,
        allowUnsandboxedCommands: false,
        unsandboxedCommandsDisabled: false,
      },
    }
    expect(isSandboxDecisionPolicyPinned('enabled')).toBe(false)
    expect(isSandboxDecisionPolicyPinned('strictSandboxMode')).toBe(true)
    expect(isSandboxDecisionPolicyPinned('allowUnsandboxedCommands')).toBe(true)
    expect(isSandboxDecisionPolicyPinned('unsandboxedCommandsDisabled')).toBe(
      true,
    )
  })
})

describe('validatePolicyLayer', () => {
  test('no policy layer means no problems', () => {
    expect(validatePolicyLayer()).toEqual([])
  })

  test('non-object sandbox is reported', () => {
    currentPolicy = { sandbox: 'yes' as unknown as Record<string, unknown> }
    const problems = validatePolicyLayer()
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('sandbox must be an object')
  })

  test('non-boolean sandbox keys are reported with their paths', () => {
    currentPolicy = {
      sandbox: {
        enabled: 'true',
        strictSandboxMode: 0,
        allowUnsandboxedCommands: false,
      },
    }
    const problems = validatePolicyLayer()
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('sandbox.enabled must be a boolean')
    expect(problems[1]).toContain('sandbox.strictSandboxMode must be a boolean')
  })

  test('clean policy yields no problems', () => {
    currentPolicy = {
      sandbox: {
        enabled: true,
        strictSandboxMode: true,
        unsandboxedCommandsDisabled: true,
        allowUnsandboxedCommands: false,
      },
    }
    expect(validatePolicyLayer()).toEqual([])
  })
})
