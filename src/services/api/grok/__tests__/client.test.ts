import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'

// Defensive: agent.test.ts can corrupt Bun's src/* path alias at runtime.
mock.module('src/utils/proxy.js', () => ({
  getProxyFetchOptions: () => ({}) as any,
}))

import { getGrokClient, clearGrokClientCache } from '../client.js'

describe('getGrokClient', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    clearGrokClientCache()
    process.env.GROK_API_KEY = 'test-key'
    delete process.env.GROK_BASE_URL
  })

  afterEach(() => {
    clearGrokClientCache()
    process.env = { ...originalEnv }
  })

  test('creates client with default base URL', () => {
    const client = getGrokClient()
    expect(client).toBeDefined()
    expect(client.baseURL).toBe('https://api.x.ai/v1')
  })

  test('uses GROK_BASE_URL when set', () => {
    process.env.GROK_BASE_URL = 'https://custom.grok.api/v1'
    clearGrokClientCache()
    const client = getGrokClient()
    expect(client.baseURL).toBe('https://custom.grok.api/v1')
  })

  test('returns cached client on second call', () => {
    const client1 = getGrokClient()
    const client2 = getGrokClient()
    expect(client1).toBe(client2)
  })

  test('clearGrokClientCache resets cache', () => {
    const client1 = getGrokClient()
    clearGrokClientCache()
    process.env.GROK_BASE_URL = 'https://other.api/v1'
    const client2 = getGrokClient()
    expect(client1).not.toBe(client2)
  })

  // ── W1：缓存命中前 options 等价校验（0032:706 每请求覆盖面）─────────

  test('shared client keeps maxRetries at 0 (request-level budget only)', () => {
    const client = getGrokClient()
    expect(client.maxRetries).toBe(0)
  })

  test('fetchOverride call never hits the cache and never poisons it', () => {
    const fetchLike = Object.assign(async () => new Response(), {
      preconnect: async () => {},
    })
    const plain = getGrokClient()
    const withOverride = getGrokClient({ fetchOverride: fetchLike })
    // override 调用不得命中缓存（旧实现在读 options 之前 return cached）
    expect(withOverride).not.toBe(plain)
    // override 构建的 client 不入缓存：随后普通调用仍是原缓存实例
    expect(getGrokClient()).toBe(plain)
  })

  test('a process-level fetch swap rebuilds the shared client', () => {
    const original = globalThis.fetch
    try {
      const plain = getGrokClient()
      globalThis.fetch = Object.assign(async () => new Response(), {
        preconnect: async () => {},
      })
      const rebuilt = getGrokClient()
      expect(rebuilt).not.toBe(plain)
    } finally {
      globalThis.fetch = original
    }
  })
})
