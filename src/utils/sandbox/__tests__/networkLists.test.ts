/** W4 (#55) — tests for the pure per-call sandbox network list merge. */
import { describe, expect, test } from 'bun:test'
import { buildCustomNetworkConfig, mergeNetworkLists } from '../networkLists.js'

describe('mergeNetworkLists', () => {
  test('builds empty lists from nothing', () => {
    expect(mergeNetworkLists(undefined, undefined)).toEqual({
      allowedDomains: [],
      deniedDomains: [],
    })
  })

  test('appends allow entries after base allowedDomains', () => {
    expect(
      mergeNetworkLists(
        { allowedDomains: ['example.com'], deniedDomains: ['evil.com'] },
        { allow: ['api.example.com'] },
      ),
    ).toEqual({
      allowedDomains: ['example.com', 'api.example.com'],
      deniedDomains: ['evil.com'],
    })
  })

  test('appends deny entries and deduplicates', () => {
    expect(
      mergeNetworkLists(
        { allowedDomains: [], deniedDomains: ['evil.com'] },
        { deny: ['evil.com', 'worse.com'] },
      ),
    ).toEqual({
      allowedDomains: [],
      deniedDomains: ['evil.com', 'worse.com'],
    })
  })

  test('merges both lists at once without mutating the base', () => {
    const base = {
      allowedDomains: ['a.com'],
      deniedDomains: ['d.com'],
      allowUnixSockets: ['/tmp/sock'],
    }
    const merged = mergeNetworkLists(base, {
      allow: ['b.com'],
      deny: ['e.com'],
    })
    expect(merged.allowedDomains).toEqual(['a.com', 'b.com'])
    expect(merged.deniedDomains).toEqual(['d.com', 'e.com'])
    expect(merged.allowUnixSockets).toEqual(['/tmp/sock'])
    // Base untouched (callers may reuse config objects).
    expect(base.allowedDomains).toEqual(['a.com'])
  })
})

describe('buildCustomNetworkConfig', () => {
  test('returns undefined when no per-call lists are given', () => {
    expect(buildCustomNetworkConfig(undefined, undefined)).toBeUndefined()
    expect(
      buildCustomNetworkConfig({ allowedHosts: ['a.com'] }, undefined),
    ).toBeUndefined()
    // Explicitly-empty lists are a no-op too (historical call shape preserved).
    expect(buildCustomNetworkConfig(undefined, {})).toBeUndefined()
    expect(
      buildCustomNetworkConfig(undefined, { allow: [], deny: [] }),
    ).toBeUndefined()
  })

  test('merges per-call lists on top of the session restriction status view', () => {
    // SandboxManager.getNetworkRestrictionConfig() shape: allowedHosts /
    // deniedHosts (status view), mapped onto the SandboxRuntimeConfig
    // allowedDomains / deniedDomains shape for customConfig.network.
    const network = buildCustomNetworkConfig(
      { allowedHosts: ['github.com'], deniedHosts: ['evil.com'] },
      { allow: ['api.github.com'], deny: ['worse.com'] },
    )
    expect(network).toEqual({
      allowedDomains: ['github.com', 'api.github.com'],
      deniedDomains: ['evil.com', 'worse.com'],
    })
  })

  test('deny-only lists keep the session allowlist intact', () => {
    const network = buildCustomNetworkConfig(
      { allowedHosts: ['github.com'] },
      { deny: ['tracker.io'] },
    )
    expect(network).toEqual({
      allowedDomains: ['github.com'],
      deniedDomains: ['tracker.io'],
    })
  })

  test('deny-only without a session allowlist yields the block-all shape', () => {
    // allowedDomains: [] is the runtime's explicit "block all" — restrictive
    // direction only; enforcement precedence stays with sandbox-runtime.
    const network = buildCustomNetworkConfig(undefined, { deny: ['evil.com'] })
    expect(network).toEqual({
      allowedDomains: [],
      deniedDomains: ['evil.com'],
    })
  })
})
