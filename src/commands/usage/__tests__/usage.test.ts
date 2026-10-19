/**
 * Regression tests for /usage command — v2.1.118 upstream alignment.
 * Verifies:
 *   - /usage is primary command with aliases ["cost", "stats"]
 *   - description covers cost + stats
 *   - availability restriction removed (not claude-ai only)
 *   - cost/stats index files emit commands with matching name
 */

import { mock, describe, test, expect } from 'bun:test'
// Locale packs read straight from JSON (not via the i18n module) so
// mock.module pollution in this process cannot affect test expectations.
import zhCN from '../../../i18n/locales/zh-CN.json'
import zhTW from '../../../i18n/locales/zh-TW.json'
import ja from '../../../i18n/locales/ja.json'
import ko from '../../../i18n/locales/ko.json'

// Must mock before importing anything that pulls in bootstrap/state
import { logMock } from '../../../../tests/mocks/log.js'
mock.module('src/utils/log.ts', logMock)

import { debugMock } from '../../../../tests/mocks/debug.js'
mock.module('src/utils/debug.ts', debugMock)

mock.module('bun:bundle', () => ({ feature: () => false }))

// Full named-export surface of src/utils/auth.ts: the /usage chain pulls
// several of these at import time, and bun mock.module replaces the whole
// module — any name not listed here becomes a SyntaxError import failure.
// Values are inert: null tokens, false subscribers, no helper.
const AUTH_MOCK_ATTRS = [
  'isAnthropicAuthEnabled',
  'getAuthTokenSource',
  'getAnthropicApiKey',
  'hasAnthropicApiKeyAuth',
  'getAnthropicApiKeyWithSource',
  'getConfiguredApiKeyHelper',
  'calculateApiKeyHelperTTL',
  'getApiKeyHelperElapsedMs',
  'getApiKeyFromApiKeyHelper',
  'getApiKeyFromApiKeyHelperCached',
  'clearApiKeyHelperCache',
  'getApiKeyFromConfigOrMacOSKeychain',
  'getClaudeAIOAuthTokens',
  'getClaudeAIOAuthTokensAsync',
  'getOauthAccountInfo',
  'getOAuthAccount',
  'getAccountInformation',
  'getRateLimitTier',
  'getSubscriptionName',
  'getSubscriptionType',
  'checkAndRefreshOAuthTokenIfNeeded',
  'checkGcpCredentialsValid',
  'clearOAuthTokenCache',
  'clearAwsCredentialsCache',
  'clearGcpCredentialsCache',
  'handleOAuth401Error',
  'hasOpusAccess',
  'hasProfileScope',
  'is1PApiCustomer',
  'isClaudeAISubscriber',
  'isConsumerSubscriber',
  'isCustomApiKeyApproved',
  'isEnterpriseSubscriber',
  'isMaxSubscriber',
  'isProSubscriber',
  'isTeamSubscriber',
  'isTeamPremiumSubscriber',
  'isAnthropicAuthEnabled',
  'isAwsAuthRefreshFromProjectSettings',
  'isAwsCredentialExportFromProjectSettings',
  'isGcpAuthRefreshFromProjectSettings',
  'isOtelHeadersHelperFromProjectOrLocalSettings',
  'isOverageProvisioningAllowed',
  'isUsing3PServices',
  'prefetchApiKeyFromApiKeyHelperIfSafe',
  'prefetchAwsCredentialsAndBedRockInfoIfSafe',
  'prefetchGcpCredentialsIfSafe',
  'refreshAwsAuth',
  'refreshAndGetAwsCredentials',
  'refreshGcpAuth',
  'refreshGcpCredentialsIfNeeded',
  'removeApiKey',
  'saveApiKey',
  'saveOAuthTokensIfNeeded',
  'getOtelHeadersFromHelper',
  'handleOAuth',
] as const
const authMock: Record<string, unknown> = {}
for (const name of AUTH_MOCK_ATTRS) authMock[name] = () => null
authMock.isClaudeAISubscriber = () => false
authMock.getOAuthAccount = () => null
mock.module('src/utils/auth.ts', () => authMock)

mock.module('src/services/claudeAiLimits.ts', () => ({
  currentLimits: { isUsingOverage: false },
}))

mock.module('src/cost-tracker.ts', () => ({
  formatTotalCost: () => 'Total cost: $0.0012',
}))

mock.module('src/utils/config.ts', () => ({
  getCurrentProjectConfig: () => ({}),
  saveCurrentProjectConfig: () => {},
  getGlobalConfig: () => ({}),
  saveGlobalConfig: () => {},
  getOrCreateUserID: () => 'test-user-id',
  getCustomApiKeyStatus: () => ({ isCustomApiKeyApproved: false }),
  checkHasTrustDialogAccepted: () => true,
  isPathTrusted: () => true,
}))

// ── helpers ──────────────────────────────────────────────────────────────────

async function loadUsageCommand() {
  const mod = await import('../index.js')
  return mod.default
}

/** Canonical English key for the /usage description (single source here). */
const USAGE_DESCRIPTION_KEY =
  'Show session cost, plan usage, and activity stats'

/**
 * Every valid rendering of the canonical description key: the English
 * passthrough plus each locale pack's entry, read directly from JSON so
 * mock.module pollution (e.g. identity-t mocks in other test files) cannot
 * affect the expectation.
 */
function descriptionRenderings(): string[] {
  const pack = (rows: Record<string, string>) => rows[USAGE_DESCRIPTION_KEY]
  return [
    USAGE_DESCRIPTION_KEY,
    pack(zhCN),
    pack(zhTW),
    pack(ja),
    pack(ko),
  ].filter((v): v is string => typeof v === 'string')
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('usage command — metadata', () => {
  test('name is "usage"', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.name).toBe('usage')
  })

  test('has aliases containing "cost"', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.aliases?.includes('cost')).toBe(true)
  })

  test('has aliases containing "stats"', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.aliases?.includes('stats')).toBe(true)
  })

  test('has exactly two aliases', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.aliases?.length).toBe(2)
  })

  test('aliases are ["cost", "stats"] in that order', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.aliases).toEqual(['cost', 'stats'])
  })

  test('description mentions cost', async () => {
    const cmd = await loadUsageCommand()
    // The description is t() of the canonical key. Other test files in this
    // process mock src/i18n last-write-wins, so the live t() may be masked;
    // instead accept any rendering of the key across the locale packs read
    // straight from JSON (unmockable).
    expect(descriptionRenderings()).toContain(cmd.description)
    expect(USAGE_DESCRIPTION_KEY).toContain('cost')
  })

  test('description mentions stat', async () => {
    const cmd = await loadUsageCommand()
    expect(descriptionRenderings()).toContain(cmd.description)
    expect(USAGE_DESCRIPTION_KEY).toContain('stat')
  })

  test('is NOT restricted exclusively to claude-ai subscribers', async () => {
    const cmd = await loadUsageCommand()
    const avail = (cmd as { availability?: string[] }).availability
    const isExclusivelyClaudeAi =
      Array.isArray(avail) && avail.length === 1 && avail[0] === 'claude-ai'
    expect(isExclusivelyClaudeAi).toBe(false)
  })

  test('description mentions usage or plan', async () => {
    const cmd = await loadUsageCommand()
    expect(descriptionRenderings()).toContain(cmd.description)
    expect(
      USAGE_DESCRIPTION_KEY.includes('usage') ||
        USAGE_DESCRIPTION_KEY.includes('plan'),
    ).toBe(true)
  })
})

describe('usage command — cost index is no longer standalone', () => {
  test('cost/index default name is "usage" (delegated) OR it has aliases', async () => {
    const mod = await import('../../cost/index.js')
    const cmd = mod.default
    // After the fix: cost/index either exports name='usage' with aliases,
    // or the cost command has aliases set (it's been demoted to alias)
    const isUnifiedOrAliased =
      cmd.name === 'usage' || (cmd.aliases?.includes('cost') ?? false)
    expect(isUnifiedOrAliased).toBe(true)
  })
})

describe('usage command — stats index is no longer standalone', () => {
  test('stats/index default name is "usage" (delegated) OR it has aliases', async () => {
    const mod = await import('../../stats/index.js')
    const cmd = mod.default
    const isUnifiedOrAliased =
      cmd.name === 'usage' || (cmd.aliases?.includes('stats') ?? false)
    expect(isUnifiedOrAliased).toBe(true)
  })
})
