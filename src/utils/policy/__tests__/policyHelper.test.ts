/**
 * W4 (#55) — tests for the Windows GPO export helper.
 * buildPolicyExports/flattenPolicySettings are pure; writePolicyHelperFiles is
 * exercised against temp files with explicit opts (which override both env and
 * the win32 platform guard) plus one env-driven case under a faked platform.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
  buildPolicyExports,
  buildPolicyModule,
  buildRegistryCommands,
  flattenPolicySettings,
  redactPolicySecrets,
  POLICY_SECRET_REDACTED,
  writePolicyHelperFiles,
} = await import('../policyHelper.js')
import type { PolicySettings } from '../policySettings.js'

const PS1_ENV = 'CLAUDE_CODE_POLICY_HELPER_PS1_PATH'
const PSM_ENV = 'CLAUDE_CODE_POLICY_HELPER_PSMODULEPATH'

const samplePolicy = {
  sandbox: {
    enabled: true,
    strictSandboxMode: true,
    unsandboxedCommandsDisabled: false,
  },
} satisfies PolicySettings

const createdDirs: string[] = []
const envSaves: Record<string, string | undefined> = {}

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'policy-helper-test-'))
  createdDirs.push(dir)
  return dir
}

function setEnvs(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    envSaves[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeEach(() => {
  currentPolicy = null
  for (const [key, value] of Object.entries(envSaves)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const key of Object.keys(envSaves)) delete envSaves[key]
})

afterAll(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('flattenPolicySettings', () => {
  test('maps nested booleans to DWORD registry entries', () => {
    expect(flattenPolicySettings(samplePolicy)).toEqual([
      { path: 'sandbox.enabled', type: 'REG_DWORD', value: '1' },
      { path: 'sandbox.strictSandboxMode', type: 'REG_DWORD', value: '1' },
      {
        path: 'sandbox.unsandboxedCommandsDisabled',
        type: 'REG_DWORD',
        value: '0',
      },
    ])
  })

  test('strings, integers, floats and arrays fall into their typed slots', () => {
    const entries = flattenPolicySettings({
      model: 'sonnet',
      timeout: 30,
      ratio: 1.5,
      list: ['a', 'b'],
    })
    expect(entries).toEqual([
      { path: 'model', type: 'REG_SZ', value: 'sonnet' },
      { path: 'timeout', type: 'REG_DWORD', value: '30' },
      { path: 'ratio', type: 'REG_SZ', value: '1.5' },
      { path: 'list', type: 'REG_SZ', value: '["a","b"]' },
    ])
  })
})

describe('buildRegistryCommands', () => {
  test('emits New-Item once per key and typed Set-ItemProperty lines', () => {
    const commands = buildRegistryCommands(
      flattenPolicySettings({
        sandbox: { enabled: true },
        permissions: { defaultMode: 'plan' },
      }),
    )
    expect(commands.filter(cmd => cmd.startsWith('New-Item'))).toHaveLength(2)
    expect(commands).toContain(
      "Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Anthropic\\ClaudeCode\\Sandbox' -Name 'Enabled' -Value 1 -Type DWORD",
    )
    expect(commands.some(cmd => cmd.endsWith('-Type SZ'))).toBe(true)
  })

  test('escapes single quotes in string values', () => {
    const commands = buildRegistryCommands([
      { path: 'permissions.defaultMode', type: 'REG_SZ', value: "don't" },
    ])
    expect(commands.some(cmd => cmd.includes("-Value 'don''t'"))).toBe(true)
  })
})

describe('buildPolicyExports / buildPolicyModule', () => {
  test('export text is readable, replayable and round-trippable', () => {
    const text = buildPolicyExports(samplePolicy, {
      generatedAtISO: '2026-01-01T00:00:00.000Z',
    })
    expect(text).toContain('# Generated: 2026-01-01T00:00:00.000Z')
    expect(text).toContain('#   sandbox.enabled (REG_DWORD) = 1')
    expect(text).toContain('# Raw policy JSON')
    expect(text).toContain('"strictSandboxMode": true')
    expect(text).toContain('Set-ItemProperty')
    expect(text).toContain('New-Item')
    // The JSON comment block round-trips: lines after the marker until the
    // first non-comment line are the pretty-printed policy.
    const lines = text.split('\n')
    const marker = lines.findIndex(line => line.includes('# Raw policy JSON'))
    const jsonLines: string[] = []
    for (const line of lines.slice(marker + 1)) {
      if (!line.startsWith('#')) break
      if (line.startsWith('# ')) jsonLines.push(line.slice(2))
    }
    expect(JSON.parse(jsonLines.join('\n'))).toEqual(samplePolicy)
  })

  test('psm1 variant wraps the replay in an exported function', () => {
    const text = buildPolicyModule(samplePolicy)
    expect(text).toContain('function Set-ClaudeCodePolicy {')
    expect(text).toContain('Export-ModuleMember -Function Set-ClaudeCodePolicy')
    expect(text).toContain('Set-ItemProperty')
  })
})

describe('redactPolicySecrets (W4 R4 on-disk secret filter)', () => {
  const secretPolicy = {
    sandbox: { enabled: true },
    gatewayAuthToken: 'tok-plain',
    apiKey: 'sk-secret',
    clientSecret: 'cs-secret',
    passphrase: 'hunter2',
    password: 'hunter3',
    nested: { api_client_cert_key_pair: { key: 'inner-secret' } },
    remaining: { list: [{ apiKey: 'x', note: 'keep-note' }, 'keep-string'] },
  }

  test('replaces secret-keyed values with <redacted> at any depth', () => {
    const safe = redactPolicySecrets(secretPolicy)
    expect(safe.gatewayAuthToken).toBe(POLICY_SECRET_REDACTED)
    expect(safe.apiKey).toBe(POLICY_SECRET_REDACTED)
    expect(safe.clientSecret).toBe(POLICY_SECRET_REDACTED)
    expect(safe.passphrase).toBe(POLICY_SECRET_REDACTED)
    expect(safe.password).toBe(POLICY_SECRET_REDACTED)
    // `nested` is not a whitelisted container → the whole object goes:
    // the Record-typed sub-object the caller WOULD have received
    // pre-hardening is replaced wholesale with the sentinel, not merely
    // filtered key-by-key.
    expect(safe.nested).toBe(POLICY_SECRET_REDACTED)
    // Non-secret paths inside RENDERABLE containers survive untouched,
    // including inside arrays.
    expect(safe.sandbox).toEqual({ enabled: true })
    // Input policy object untouched.
    expect(secretPolicy.gatewayAuthToken).toBe('tok-plain')
  })

  test('redaction authority table (对照表): extended credential key families', () => {
    // Families the original TOKEN/KEY/SECRET/PHRASE/PASSWORD pattern missed —
    // each never reaches a rendered artifact.
    const safe = redactPolicySecrets({
      sandbox: { enabled: true },
      authorization: 'Bearer tok',
      userCredentials: 'user:pass',
      passwd: 'hunter4',
      clientCertificate: '---BEGIN CERT---',
      CertPath: '/secure/things',
      AuthTokenEnv: 'tok-env',
      credentialsFile: 'also-redacted',
      // AUTH is a prefix family per the review prescription — scalar keys
      // merely STARTING with it are collateral of the denylist (documented
      // trade-off; no official policySettings scalar starts with AUTH).
      authority: 'collaterally-redacted',
      // A genuinely unmatched structural scalar must survive.
      preferredNotifChannel: 'iterm2',
    })
    expect(safe.authorization).toBe(POLICY_SECRET_REDACTED)
    expect(safe.userCredentials).toBe(POLICY_SECRET_REDACTED)
    expect(safe.passwd).toBe(POLICY_SECRET_REDACTED)
    expect(safe.clientCertificate).toBe(POLICY_SECRET_REDACTED)
    expect(safe.CertPath).toBe(POLICY_SECRET_REDACTED)
    expect(safe.AuthTokenEnv).toBe(POLICY_SECRET_REDACTED)
    expect(safe.credentialsFile).toBe(POLICY_SECRET_REDACTED)
    expect(safe.authority).toBe(POLICY_SECRET_REDACTED)
    expect(safe.preferredNotifChannel).toBe('iterm2')
  })

  test('unknown nested objects default to WHOLESALE redaction (对照表 default)', () => {
    const safe = redactPolicySecrets({
      sandbox: { enabled: true },
      unknownBlock: { anyKey: 'future content', deeper: { nested: true } },
    })
    // `unknownBlock` is not on the renderable whitelist — the entire object
    // is replaced, not merely keys matching the denylist.
    expect(safe.unknownBlock).toBe(POLICY_SECRET_REDACTED)
    expect(safe.sandbox).toEqual({ enabled: true })
  })

  test('the official env block (credential carrier) is a non-member — rendered wholesale as <redacted>', () => {
    const safe = redactPolicySecrets({
      sandbox: { enabled: true },
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-token',
        ANTHROPIC_CUSTOM_HEADERS: '{"Authorization":"Bearer gw"}',
        ANTHROPIC_BASE_URL: 'https://gw.internal',
      },
    })
    expect(safe.env).toBe(POLICY_SECRET_REDACTED)
    expect(JSON.stringify(safe)).not.toContain('https://gw.internal')
  })

  test('renderable whitelisted paths keep their structure (对照表 members)', () => {
    const safe = redactPolicySecrets({
      sandbox: {
        enabled: true,
        filesystem: {
          allow: ['/proj'],
          deny: ['/etc'],
          extraUnknownObject: { union: 'types' },
        },
      },
      permissions: { defaultMode: 'plan' },
      hooks: { PostModelSwitch: 'echo done' },
      statusLine: { type: 'command' },
    })
    expect(safe.sandbox).toEqual({
      enabled: true,
      filesystem: {
        allow: ['/proj'],
        deny: ['/etc'],
        // Unknown object nested INSIDE a whitelisted path still obeys the
        // unknown-object default (whitelist prefixes stay whitelist-checked
        // per key).
        extraUnknownObject: POLICY_SECRET_REDACTED,
      },
    })
    expect(safe.permissions).toEqual({ defaultMode: 'plan' })
    expect(safe.hooks).toEqual({ PostModelSwitch: 'echo done' })
    expect(safe.statusLine).toEqual({ type: 'command' })
  })

  test('exports and modules never render secret values on disk', () => {
    const exportsText = buildPolicyExports(secretPolicy)
    expect(exportsText).toContain(POLICY_SECRET_REDACTED)
    expect(exportsText).not.toContain('tok-plain')
    expect(exportsText).not.toContain('sk-secret')
    expect(exportsText).not.toContain('hunter2')
    expect(exportsText).not.toContain('inner-secret')
    // Whitelisted structural content still renders.
    expect(exportsText).toContain('"enabled": true')

    const moduleText = buildPolicyModule(secretPolicy)
    expect(moduleText).toContain(POLICY_SECRET_REDACTED)
    expect(moduleText).not.toContain('tok-plain')
    expect(moduleText).not.toContain('sk-secret')
  })

  test('extended families never leak through the written artifact either', () => {
    const leakPolicy = {
      sandbox: { enabled: true },
      authorization: 'Bearer gw-token-xyz',
      env: { ANTHROPIC_CUSTOM_HEADERS: '{"Authorization":"Bearer gw2"}' },
      unknownVendor: { inlineUrl: 'https://user:pw@host' },
    }
    const text = buildPolicyExports(leakPolicy)
    expect(text).not.toContain('gw-token-xyz')
    expect(text).not.toContain('gw2')
    expect(text).not.toContain('user:pw@host')
    expect(text).toContain(POLICY_SECRET_REDACTED)
  })

  test('written artifacts are redacted end to end', () => {
    currentPolicy = secretPolicy
    const dir = newTempDir()
    const written = writePolicyHelperFiles({
      ps1Path: join(dir, 'policy.ps1'),
    })
    expect(written).toHaveLength(1)
    const ps1 = readFileSync(written[0]!, 'utf8')
    expect(ps1).toContain(POLICY_SECRET_REDACTED)
    expect(ps1).not.toContain('tok-plain')
    expect(ps1).not.toContain('hunter3')
  })
})

describe('writePolicyHelperFiles', () => {
  test('default (no opts, no env) is a no-op returning []', () => {
    currentPolicy = samplePolicy
    setEnvs({ [PS1_ENV]: undefined, [PSM_ENV]: undefined })
    expect(writePolicyHelperFiles()).toEqual([])
  })

  test.skipIf(process.platform === 'win32')(
    'non-win32 default skips even with env paths set',
    () => {
      currentPolicy = samplePolicy
      setEnvs({ [PS1_ENV]: join(newTempDir(), 'policy.ps1') })
      expect(writePolicyHelperFiles()).toEqual([])
    },
  )

  test('opts paths force the write regardless of platform', () => {
    currentPolicy = samplePolicy
    const dir = newTempDir()
    const written = writePolicyHelperFiles({
      ps1Path: join(dir, 'claude-code-policy.ps1'),
      psmPath: join(dir, 'claude-code-policy.psm1'),
    })
    expect(written).toHaveLength(2)
    const ps1 = readFileSync(written[0]!, 'utf8')
    expect(ps1).toContain('Set-ItemProperty')
    expect(readFileSync(written[1]!, 'utf8')).toContain('Set-ClaudeCodePolicy')
    // The .ps1 must embed the current policy content.
    expect(ps1).toContain('"strictSandboxMode": true')
  })

  test('opts outDir writes both artifacts with default names', () => {
    currentPolicy = samplePolicy
    const dir = newTempDir()
    const written = writePolicyHelperFiles({ outDir: dir })
    expect(written).toHaveLength(2)
    expect(written[0]).toContain('claude-code-policy.ps1')
    expect(written[1]).toContain('claude-code-policy.psm1')
    expect(readFileSync(written[0]!, 'utf8')).toContain('HKLM')
  })

  test('no policySettings source means nothing to export', () => {
    currentPolicy = null
    const dir = newTempDir()
    expect(writePolicyHelperFiles({ ps1Path: join(dir, 'x.ps1') })).toEqual([])
    expect(writePolicyHelperFiles({ outDir: dir })).toEqual([])
  })
})
