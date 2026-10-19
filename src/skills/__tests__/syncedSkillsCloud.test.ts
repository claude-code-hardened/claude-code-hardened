/**
 * Cloud face of syncedSkills with the SKILLS_SYNC gate forced OPEN via the
 * fetchSkillHealthIfEnabled gateOverride seam (R5 item: the always-on path
 * had no test — the sibling syncedSkills.test.ts pins the default-OFF
 * no-network behavior). bun:bundle is NOT re-mocked here: the mock is
 * process-global in bun:test and would race with the other file in this
 * directory. Auth headers flow through the authHeaders seam (mirroring
 * fetchImpl); the production default is the shared getAuthHeaders() builder,
 * which this module imports directly (reuse is structural, not mocked). No
 * real network.
 */
import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../tests/mocks/log'
import { debugMock } from '../../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

const synced = await import('../syncedSkills.js')

const AUTH_HEADERS = {
  Authorization: 'Bearer test-oauth-token',
  'anthropic-beta': 'oauth-2025-04-20',
}

function makeHealthResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function fetchOn(body: unknown | Response): Promise<Map<string, string>> {
  return synced.fetchSkillHealthIfEnabled({
    gateOverride: true,
    fetchImpl: ((url: string, init?: RequestInit) => {
      seen.url = url
      seen.headers = init?.headers as Record<string, string>
      return Promise.resolve(
        body instanceof Response ? body : makeHealthResponse(body),
      )
    }) as unknown as typeof fetch,
    authHeaders: AUTH_HEADERS,
  })
}

const seen: { url: string; headers: Record<string, string> } = {
  url: '',
  headers: {},
}

describe('fetchSkillHealthIfEnabled with the gate forced open (always-on path)', () => {
  test('gateOverride runs the fetch face; the production default reads the feature gate', () => {
    // Default (no override) stays feature-gated: SKILLS_SYNC is off in test
    // builds, so the wrapper is a no-op — pinned in syncedSkills.test.ts.
    expect(synced.isSkillsSyncEnabled()).toBe(false)
  })

  test('fetches health with the shared-auth headers attached', async () => {
    const health = await fetchOn({
      skills: [
        { skill_name: 'Weather', health: 'synced' },
        { skill_name: 'Broken', health: 'orphaned' },
      ],
    })
    expect(seen.url).toBe('https://claude.ai/api/claude_code/skills')
    // R5: header reuse — the dashboard fetch now authenticates.
    expect(seen.headers['Authorization']).toBe('Bearer test-oauth-token')
    expect(seen.headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(health.get('Weather')).toBe('synced')
    expect(health.get('Broken')).toBe('orphaned')
  })

  test('401 degrades to an empty map (no throw, no partial data)', async () => {
    const health = await fetchOn(new Response('unauthorized', { status: 401 }))
    expect(health.size).toBe(0)
  })

  test('invalid payload shapes degrade to an empty map', async () => {
    for (const body of [{}, { skills: 'not-an-array' }, null]) {
      const health = await fetchOn(body)
      expect(health.size).toBe(0)
    }
  })

  test('non-string health entries are skipped, valid siblings kept', async () => {
    const health = await fetchOn({
      skills: [
        { skill_name: 'Ok', health: 'healthy' },
        { skill_name: 'Bad', health: 42 },
        { skill_name: '' },
      ],
    })
    expect(health.size).toBe(1)
    expect(health.get('Ok')).toBe('healthy')
  })
})
