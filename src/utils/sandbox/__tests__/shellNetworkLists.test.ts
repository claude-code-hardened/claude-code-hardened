/**
 * W4 (#55) — asserts the Shell.exec → SandboxManager.wrapWithSandbox wiring
 * for the BashTool per-call network lists: customConfig.network carries the
 * session restriction config merged with the { allow, deny } lists, and the
 * historical customConfig=undefined call shape is preserved when no lists are
 * passed.
 *
 * Shell.js imports the adapter relatively; the mock is registered under both
 * specifier forms (see tests/mocks conventions — mock.module is process-global
 * per file, and no other file in this directory imports the adapter for real).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

const wrapWithSandboxMock = mock(async () => {
  throw new Error('sandbox-test: stop before spawn')
})
// Status view shape (see SandboxManager.getNetworkRestrictionConfig()).
const getNetworkRestrictionConfigMock = mock(() => ({
  allowedHosts: ['github.com'],
  deniedHosts: ['evil.com'],
}))

const sandboxManagerMock = {
  wrapWithSandbox: wrapWithSandboxMock,
  getNetworkRestrictionConfig: getNetworkRestrictionConfigMock,
  cleanupAfterCommand: () => {},
}

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/sandbox/sandbox-adapter.ts', () => ({
  SandboxManager: sandboxManagerMock,
}))
mock.module('src/utils/sandbox/sandbox-adapter.js', () => ({
  SandboxManager: sandboxManagerMock,
}))

const { exec } = await import('src/utils/Shell.js')

beforeEach(() => {
  wrapWithSandboxMock.mockClear()
  getNetworkRestrictionConfigMock.mockClear().mockImplementation(() => ({
    allowedHosts: ['github.com'],
    deniedHosts: ['evil.com'],
  }))
})

function freshSignal(): AbortSignal {
  return new AbortController().signal
}

describe('Shell.exec per-call sandbox network lists (W4)', () => {
  test('merges session config + per-call lists into customConfig.network', async () => {
    await expect(
      exec('true', freshSignal(), 'bash', {
        shouldUseSandbox: true,
        networkLists: { allow: ['api.github.com'], deny: ['worse.com'] },
      }),
    ).rejects.toThrow('sandbox-test: stop before spawn')

    expect(wrapWithSandboxMock).toHaveBeenCalledTimes(1)
    const calls = wrapWithSandboxMock.mock.calls[0] as unknown[]
    const [, binShell, customConfig] = calls as [
      string,
      string | undefined,
      { network: unknown } | undefined,
    ]
    expect(typeof binShell).toBe('string')
    expect(customConfig).toBeDefined()
    expect(customConfig?.network).toEqual({
      allowedDomains: ['github.com', 'api.github.com'],
      deniedDomains: ['evil.com', 'worse.com'],
    })
  })

  test('deny-only lists keep the session allowlist intact', async () => {
    await expect(
      exec('true', freshSignal(), 'bash', {
        shouldUseSandbox: true,
        networkLists: { deny: ['tracker.io'] },
      }),
    ).rejects.toThrow('sandbox-test: stop before spawn')

    const calls = wrapWithSandboxMock.mock.calls[0] as unknown[]
    const [, , customConfig] = calls as [
      string,
      string | undefined,
      { network: unknown } | undefined,
    ]
    expect(customConfig?.network).toEqual({
      allowedDomains: ['github.com'],
      deniedDomains: ['evil.com', 'tracker.io'],
    })
  })

  test('no lists → customConfig stays undefined (historical call shape)', async () => {
    await expect(
      exec('true', freshSignal(), 'bash', { shouldUseSandbox: true }),
    ).rejects.toThrow('sandbox-test: stop before spawn')

    const calls = wrapWithSandboxMock.mock.calls[0] as unknown[]
    const [, , customConfig] = calls as [
      string,
      string | undefined,
      { network: unknown } | undefined,
    ]
    expect(customConfig).toBeUndefined()
  })
})
