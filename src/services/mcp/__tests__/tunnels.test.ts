/**
 * Tests for the MCP tunnels cloud client skeleton (0032 anchor):
 * fail-closed gating (MCP_TUNNELS build flag defaults off → every request
 * throws before touching the network), the mcp-tunnels-2026-06-22 version
 * header injection, and base-URL resolution. Fully offline — the injected
 * fetchFn spy proves no cloud dependency fires while the gate is off.
 */
import { describe, expect, test } from 'bun:test'

import {
  buildTunnelsHeaders,
  createTunnelsClient,
  McpTunnelsDisabledError,
  MCP_TUNNELS_BETA_HEADER,
  getTunnelsBaseUrl,
  isMcpTunnelsEnabled,
} from '../tunnels.js'
import { getOauthConfig } from 'src/constants/oauth.js'

describe('isMcpTunnelsEnabled', () => {
  test('MCP_TUNNELS is not in DEFAULT_BUILD_FEATURES — gate defaults off', () => {
    expect(isMcpTunnelsEnabled()).toBe(false)
  })
})

describe('createTunnelsClient (gate off)', () => {
  test('list() is fail-closed: throws McpTunnelsDisabledError before any fetch', async () => {
    let fetched = false
    const client = createTunnelsClient({
      baseUrl: 'https://tunnels.test',
      // Minimal spy stub; the full fetch surface is irrelevant to this
      // fail-closed assertion.
      fetchFn: (() => {
        fetched = true
        return Promise.resolve(new Response('{}'))
      }) as unknown as typeof fetch,
    })
    expect(client.list()).rejects.toBeInstanceOf(McpTunnelsDisabledError)
    await Bun.sleep(1)
    expect(fetched).toBe(false)
  })

  test('nested certificates resource is equally gated', async () => {
    const client = createTunnelsClient({ baseUrl: 'https://tunnels.test' })
    expect(
      client.certificates.create({ tunnel_id: 'tnl_123', csr: 'PEM' }),
    ).rejects.toBeInstanceOf(McpTunnelsDisabledError)
    expect(
      client.certificates.retrieve('tnl_123', 'cert_1'),
    ).rejects.toBeInstanceOf(McpTunnelsDisabledError)
  })

  test('disabled error names the enabling env var', async () => {
    const client = createTunnelsClient({ baseUrl: 'https://tunnels.test' })
    try {
      await client.retrieve('tnl_1')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(McpTunnelsDisabledError)
      expect((error as Error).message).toContain('FEATURE_MCP_TUNNELS')
    }
  })
})

describe('buildTunnelsHeaders', () => {
  test('injects the mcp-tunnels beta version header (0032 anchor)', () => {
    const headers = buildTunnelsHeaders()
    expect(headers['anthropic-beta']).toBe(MCP_TUNNELS_BETA_HEADER)
    expect(MCP_TUNNELS_BETA_HEADER).toBe('mcp-tunnels-2026-06-22')
    expect(headers['content-type']).toBe('application/json')
  })

  test('per-call extras merge over the version header', () => {
    const headers = buildTunnelsHeaders({ 'x-request-id': 'req_1' })
    expect(headers['x-request-id']).toBe('req_1')
    expect(headers['anthropic-beta']).toBe(MCP_TUNNELS_BETA_HEADER)
  })
})

describe('getTunnelsBaseUrl', () => {
  test('explicit option wins and trailing slash is stripped', () => {
    expect(getTunnelsBaseUrl('https://proxy.test/')).toBe('https://proxy.test')
  })

  test('defaults to the configured first-party API base', () => {
    expect(getTunnelsBaseUrl()).toBe(
      getOauthConfig().BASE_API_URL.replace(/\/$/, ''),
    )
  })
})
