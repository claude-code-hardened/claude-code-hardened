/**
 * W2.4 / W6.3 回归：codex client 缓存 LRU(2) + invalidate 强制换新。
 *
 * 官方基准：
 * - 0003-chunk-zrkp23rq/module-005-uncategorized.js:1291（封顶 Map 缓存面）：
 *   `function D(U){...if(R.size>=r)R.delete(R.keys().next().value);
 *   return R.set(U,G),G}` —— 超限驱逐最旧键；`j(U,B){...R.get(B)===U&&
 *   R.delete(B)}` —— 条件失效删除。
 * - 0003-chunk-zrkp23rq/model-provider/anthropic.js:41（sharedClient 面）：
 *   `g=h?h.sharedClient:buildClient(...)` —— 每凭据身份复用共享 client。
 * - 0032 module-002:7 + module-005:692（Egt.invalidate）：`this.cached=null,
 *   this.nextForce=!0` —— invalidate 保底强制下一次 getToken 刷新（W2.4）。
 *
 * Bugs 修复前：单槽缓存，且 invalidateCachedCodexClient 只丢 client——
 * 被吊销但未过期的 token 原样重发。
 *
 * 探针：mock openai 的 SDK 类（忠实转存构造参数，进程内与真实类同形）；
 * chatgptAuth 保持真实 —— token 由 auth.json 文件驱动（exp 远期不触发
 * 刷新曲线），codex URL 的 fetch 桩恒回 401（走 createChatGPTResponses-
 - Stream 的 catch → watchdog.settle() 清理面，不留流生命周期悬挂）。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../../../tests/mocks/log'
import { debugMock } from '../../../../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

// ─── FakeOpenAI（忠实面：clientCache.isolated / grok client 测试同进程共存
// 时，它们读到的 maxRetries/baseURL 语义与真实类一致）─────────────────────
const builtClientKeys: string[] = []

class FakeResponses {
  private readonly owner: FakeOpenAI
  constructor(owner: FakeOpenAI) {
    this.owner = owner
  }
  // 与真实 SDK 同形：create 真的出网（走进程 fetch → 测试桩拦截 codex
  // URL），以响应面抛 APIError 形状（status/headers），让
  // createChatGPTResponsesStream 走完整 establishment-catch 面。
  async create(): Promise<never> {
    const accountId = (this.owner.defaultHeaders?.['ChatGPT-Account-Id'] ??
      this.owner.defaultHeaders?.['chatgpt-account-id']) as string | undefined
    const res = await globalThis.fetch(
      'https://chatgpt.com/backend-api/codex/responses',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.owner.apiKey}`,
          ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
        },
      },
    )
    throw Object.assign(new Error('unauthorized'), {
      status: res.status,
      headers: res.headers,
    })
  }
}

class FakeOpenAI {
  apiKey: string
  baseURL: string | undefined
  maxRetries: number
  timeout: number | undefined
  fetch: unknown
  defaultHeaders: Record<string, unknown> | undefined
  responses: FakeResponses
  constructor(options: Record<string, unknown>) {
    this.apiKey = String(options.apiKey)
    this.baseURL = options.baseURL as string | undefined
    this.maxRetries = Number(options.maxRetries ?? 0)
    this.timeout = options.timeout as number | undefined
    this.fetch = options.fetch
    this.defaultHeaders = options.defaultHeaders as
      | Record<string, unknown>
      | undefined
    builtClientKeys.push(this.apiKey)
    this.responses = new FakeResponses(this)
  }
}

mock.module('openai', () => ({ default: FakeOpenAI }))

import {
  createChatGPTResponsesStream,
  invalidateCachedCodexClient,
} from '../responsesAdapter.js'
import { getValidChatGPTAuth } from '../chatgptAuth.js'

// ─── 真实 chatgptAuth 的文件/网络桩 ─────────────────────────────────────────
const CODEX_URL_PREFIX = 'https://chatgpt.com/backend-api/codex/responses'
const REFRESH_URL = 'https://auth.openai.com/oauth/token'

let configDir: string
let savedConfigDir: string | undefined
let originalFetch: typeof globalThis.fetch
let codexAuthHeaders: Array<{ authorization?: string; accountId?: string }> = []
let refreshCallCount = 0
let refreshCounter = 0

function base64url(json: unknown): string {
  return Buffer.from(JSON.stringify(json), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeJwt(claims: Record<string, unknown>): string {
  return `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url(claims)}.sig`
}

/** 把 accessToken 写进 auth.json（exp 远期：不触发过期曲线）。 */
async function seedAccessToken(token: string): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const body = {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: makeJwt({ sub: 'user-1', exp }),
      access_token: token,
      refresh_token: 'refresh-token-seed',
      account_id: 'acct_test',
    },
  }
  await writeFile(
    join(configDir, 'openai-chatgpt-auth.json'),
    `${JSON.stringify(body, null, 2)}\n`,
    { mode: 0o600 },
  )
}

async function establish(token: string): Promise<void> {
  await seedAccessToken(token)
  await createChatGPTResponsesStream({
    request: { model: 'gpt-5.5' } as never,
    signal: new AbortController().signal,
  }).catch(() => undefined) // 401 失败路径即探针
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cch-codex-cache-'))
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  originalFetch = globalThis.fetch
  builtClientKeys.length = 0
  codexAuthHeaders = []
  refreshCallCount = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === CODEX_URL_PREFIX) {
      const headers: Record<string, string> = {}
      const raw = init?.headers
      if (raw instanceof Headers) {
        for (const [k, v] of raw.entries()) headers[k.toLowerCase()] = v
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === 'string') headers[k.toLowerCase()] = v
        }
      }
      codexAuthHeaders.push({
        authorization: headers.authorization,
        accountId: headers['chatgpt-account-id'],
      })
      return new Response(JSON.stringify({ error: { message: '401' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === REFRESH_URL) {
      refreshCallCount++
      refreshCounter++
      const exp = Math.floor(Date.now() / 1000) + 3600
      return new Response(
        JSON.stringify({
          id_token: makeJwt({ sub: 'user-1', exp, n: refreshCounter }),
          access_token: makeJwt({ sub: 'user-1', exp, n: refreshCounter }),
          refresh_token: `refresh-token-gen-${refreshCounter}`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return originalFetch(input, init)
  }) as typeof fetch
  // 面具暖机：前序测试（或前序文件）留下的 nextForce 在这里消费完毕
  // （真实 getValidChatGPTAuth 的 force 语义：读后即清），保证每个用例
  // 从 force-clean 起跑；warmup 的刷新不计入用例内断言。
  refreshCounter = 0
  refreshCallCount = 0
  await seedAccessToken('warmup-token')
  await getValidChatGPTAuth()
  refreshCounter = 0
  refreshCallCount = 0
  builtClientKeys.length = 0
  codexAuthHeaders = []
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  invalidateCachedCodexClient()
  await rm(configDir, { recursive: true, force: true })
})

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.')
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  )
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >
}

describe('codex client cache: LRU(2) + conditional invalidation + W2.4 invalidate', () => {
  test('reuses the shared client per auth identity; LRU(2) keeps A across one rotation', async () => {
    await establish('token-A')
    await establish('token-B')
    await establish('token-A') // LRU(2) 命中（单槽旧实现：此处必须重建）
    await establish('token-C') // 插入 C，驱逐 B（官方 D(U) 驱逐面）
    await establish('token-B') // B 已被驱逐 → 重建

    // 官方 sharedClient 面（anthropic.js:41 `g=h?h.sharedClient:...`）：
    // 同一身份命中同一实例 → 第三个 token-A 不再构造。
    // builds: A, B, C, B —— 单槽旧实现在此序列下为 A, B, A, C, B（5 次）。
    expect(builtClientKeys).toEqual([
      'token-A',
      'token-B',
      'token-C',
      'token-B',
    ])
    // 每次 establishment 恰好一次 codex 出网（401 桩）。
    expect(codexAuthHeaders).toHaveLength(5)
  })

  test('invalidateCachedCodexClient drops the pool AND forces a token refresh (W2.4 Egt.invalidate)', async () => {
    await establish('token-A')
    await establish('token-B') // cache = {A, B}，两者都未触发刷新

    expect(refreshCallCount).toBe(0)
    invalidateCachedCodexClient()
    // W2.4 联动生效：invalidate 同时置 nextForce —— 下一次
    // getValidChatGPTAuth 即使文件内 token 未过期，也强制走 refreshTokens
    // 换新（旧实现只丢 client 缓存，被吊销 token 原样重发）；池已清空
    // → 刷新产物作为新键重建 codex client（第三参构造）。
    await establish('token-A')
    expect(refreshCallCount).toBe(1)
    expect(builtClientKeys).toHaveLength(3)
    expect(builtClientKeys[0]).toBe('token-A')
    expect(builtClientKeys[1]).toBe('token-B')
    expect(decodeJwtPayload(builtClientKeys[2]).n).toBe(1)
    // codex 出网携带的是刷新产物（jwt.n=1），绝不是文件里的旧 token。
    const bearer = codexAuthHeaders[codexAuthHeaders.length - 1]?.authorization
    const tokenPart = bearer?.replace(/^Bearer /, '')
    expect(tokenPart).toBeDefined()
    expect(decodeJwtPayload(tokenPart ?? '').n).toBe(1)
    // 强制刷新已落盘（原子写联动）：文件里也是新代。
    const onDisk = JSON.parse(
      await readFile(join(configDir, 'openai-chatgpt-auth.json'), 'utf8'),
    ) as { tokens?: { access_token?: string } }
    expect(decodeJwtPayload(onDisk.tokens?.access_token ?? '').n).toBe(1)
    // 落盘目录无 .tmp 残留（W2.2 原子写联动）。
    expect((await readdir(configDir)).filter(n => n.endsWith('.tmp'))).toEqual(
      [],
    )
    expect(refreshCounter).toBe(1)
  })
})
