/**
 * W1 回归：共享 client 单例吞参数。
 *
 * Bug: getOpenAIClient 把缓存判断放在读 options 之前——先建缓存者的
 * maxRetries/fetchOverride 压住后来调用点：主循环（maxRetries:0 +
 * fetchOverride=转储包装）拿到 sideQuery 先建的 maxRetries:2 缓存
 * （SDK 3×外层兜底出网重试，违背 client 的 double-billing 契约），或
 * fetchOverride 被静默丢弃（query.ts dumpPrompts 捕获面失效）。
 *
 * 官方 0032-chunk-dyqmyxqn/module-005-uncategorized.js:706（W1 每请求
 * 覆盖面）：`makeRequest` 以 `let s=await e,o=s.maxRetries??this.
 * maxRetries` 起手——预算是请求级参数，构造值只是缺省。修法：共享缓存
 * 恒以 maxRetries:0 构造（请求级预算走 create 的 RequestOptions），缓存
 * 命中前做 fetchOverride/fetch 身份等价校验。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../tests/mocks/log'
import { debugMock } from '../../../../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

import { clearOpenAIClientCache, getOpenAIClient } from '../client.js'

beforeEach(() => {
  clearOpenAIClientCache()
})

afterEach(() => {
  clearOpenAIClientCache()
})

describe('getOpenAIClient shared cache (W1)', () => {
  test('reuses one cached client across calls with maxRetries fixed at 0', () => {
    const a = getOpenAIClient()
    const b = getOpenAIClient()
    expect(b).toBe(a)
    // double-billing 契约：主循环重试所有权在 QueryEngine，共享 client
    // 恒为 0（官方 0032:706 请求级覆盖面下构造预算只是缺省，不再有
    // 「先建缓存者的 2」把 0 压掉的面）。
    expect(a.maxRetries).toBe(0)
  })

  test('fetchOverride call never hits the cache and never poisons it', () => {
    const fetchLike = Object.assign(async () => new Response(), {
      preconnect: async () => {},
    })
    const plain = getOpenAIClient()
    const withOverride = getOpenAIClient({ fetchOverride: fetchLike })
    // override 调用不得命中缓存（旧实现在读 options 之前 return cached）
    expect(withOverride).not.toBe(plain)
    // override 构建的 client 也不入缓存：随后的普通调用仍是原缓存实例
    expect(getOpenAIClient()).toBe(plain)
  })

  test('a different fetchOverride per caller gets its own client', () => {
    const fetchA = Object.assign(async () => new Response(), {
      preconnect: async () => {},
    })
    const fetchB = Object.assign(async () => new Response(), {
      preconnect: async () => {},
    })
    const a = getOpenAIClient({ fetchOverride: fetchA })
    const b = getOpenAIClient({ fetchOverride: fetchB })
    expect(b).not.toBe(a)
  })

  test('a process-level fetch swap rebuilds the shared client', () => {
    const original = globalThis.fetch
    try {
      const plain = getOpenAIClient()
      // globalThis.fetch 是进程级可替换面：捕获引用不一致必须重建，
      // 否则旧 fetch 的行为泄漏给新调用方。
      globalThis.fetch = Object.assign(async () => new Response(), {
        preconnect: async () => {},
      })
      const rebuilt = getOpenAIClient()
      expect(rebuilt).not.toBe(plain)
      // rebuilt 后恢复，再次按新身份重建
      globalThis.fetch = original
      expect(getOpenAIClient()).not.toBe(rebuilt)
    } finally {
      globalThis.fetch = original
    }
  })
})
