/**
 * W2.1 / W2.2 / W2.4 回归：ChatGPT token 缓存的官方 Egt 面。
 *
 * 官方基准（0032-chunk-dyqmyxqn）：module-002-class-hierarchy.js:7 +
 * module-005-uncategorized.js:692 原文：
 *   refresh(e=!1){if(this.pendingRefresh&&!e)return this.pendingRefresh;
 *     return this.doRefresh(e)}          — W2.1 并发单飞（共享解析 Promise）
 *   invalidate(){this.cached=null,this.nextForce=!0} — W2.4 强制下次刷新
 *   （authHeaders 的 `if(this._authState.resolution)await this.
 *   _authState.resolution` 为同一单飞面，module-005:706）
 *
 * Bugs 修复前：并发刷新各自发起（第二个用已轮换的 refresh_token 请求，
 * 服务端可吊销会话）且 writeFile 非原子（旧值可覆盖新值/半截 JSON）。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../../tests/mocks/debug'

mock.module('src/utils/debug.js', () => debugMock())

import {
  getValidChatGPTAuth,
  invalidateChatGPTTokenCache,
} from '../chatgptAuth.js'

const ISSUER = 'https://auth.openai.com'

// ─── helpers ─────────────────────────────────────────────────────────────────

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

type TokenGen = {
  idToken: string
  accessToken: string
  refreshToken: string
}

function tokensWithExpiry(expSeconds: number, generation: number): TokenGen {
  return {
    idToken: makeJwt({ sub: 'user-1', exp: expSeconds }),
    accessToken: makeJwt({ sub: 'user-1', exp: expSeconds, generation }),
    refreshToken: `refresh-token-gen-${generation}`,
  }
}

function jwtGeneration(token: string): number | undefined {
  const [, payload] = token.split('.')
  if (!payload) return undefined
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  )
  const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
    generation?: number
  }
  return claims.generation
}

let configDir: string
let savedConfigDir: string | undefined
let originalFetch: typeof globalThis.fetch
let refreshCallCount: number
let refreshGeneration: number

async function seedAuthFile(tokens: TokenGen): Promise<void> {
  const body = {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: 'acct_test',
    },
  }
  await writeFile(
    join(configDir, 'openai-chatgpt-auth.json'),
    `${JSON.stringify(body, null, 2)}\n`,
    { mode: 0o600 },
  )
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cch-chatgpt-auth-'))
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  originalFetch = globalThis.fetch
  refreshCallCount = 0
  refreshGeneration = 10
  // 只拦截 token 刷新端点；其余 URL 落回真 fetch（测试里没有别的出网）。
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === `${ISSUER}/oauth/token`) {
      const body = init?.body as URLSearchParams
      if (String(body?.get('grant_type')) === 'refresh_token') {
        refreshCallCount++
        const fresh = tokensWithExpiry(
          Math.floor(Date.now() / 1000) + 3600,
          refreshGeneration,
        )
        refreshGeneration++
        return new Response(
          JSON.stringify({
            id_token: fresh.idToken,
            access_token: fresh.accessToken,
            refresh_token: fresh.refreshToken,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
    }
    return originalFetch(input, init)
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  await rm(configDir, { recursive: true, force: true })
})

// ─── tests ───────────────────────────────────────────────────────────────────

describe('getValidChatGPTAuth token refresh (W2.1/W2.2/W2.4)', () => {
  test('expired token triggers a refresh and persists the new tokens', async () => {
    await seedAuthFile(
      tokensWithExpiry(Math.floor(Date.now() / 1000) - 3600, 1),
    )

    const auth = await getValidChatGPTAuth()

    expect(refreshCallCount).toBe(1)
    // 新 token 是第 10 代（mock 刷新端点产出的首代）。
    expect(jwtGeneration(auth.accessToken)).toBe(10)
    // 新值已原子落盘：读回文件应与返回一致（access_token 非旧代）。
    const raw = await readFile(
      join(configDir, 'openai-chatgpt-auth.json'),
      'utf8',
    )
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: string } }
    expect(parsed.tokens?.access_token).toBe(auth.accessToken)
  })

  test('concurrent callers share one refresh (official pendingRefresh single-flight)', async () => {
    await seedAuthFile(
      tokensWithExpiry(Math.floor(Date.now() / 1000) - 3600, 1),
    )

    // 三个并发调用同时读到期文件：只允许 ONE 次 HTTP 刷新（官方
    // `if(this.pendingRefresh&&!e)return this.pendingRefresh`），全部
    // 拿同一份新 token；第二、第三调用不得用已轮换的 refresh_token
    // 再次发起（旧实现的服务端会话吊销面）。
    const results = await Promise.all([
      getValidChatGPTAuth(),
      getValidChatGPTAuth(),
      getValidChatGPTAuth(),
    ])

    expect(refreshCallCount).toBe(1)
    expect(results[0].accessToken).toBe(results[1].accessToken)
    expect(results[1].accessToken).toBe(results[2].accessToken)
  })

  test('invalidateChatGPTTokenCache forces a refresh of an UNEXPIRED token (W2.4, consumed once)', async () => {
    // 未过期 token（401 吊销面）：失效标志必须强制换新，不能原样重发。
    await seedAuthFile(
      tokensWithExpiry(Math.floor(Date.now() / 1000) + 3600, 1),
    )

    invalidateChatGPTTokenCache()
    const first = await getValidChatGPTAuth()
    expect(refreshCallCount).toBe(1)
    // nextForce 消费即清：下一次未过期调用不再刷新。
    const second = await getValidChatGPTAuth()
    expect(refreshCallCount).toBe(1)
    // 强制面产出的 token 是第 10 代（非文件里 seed 的第 1 代旧值）。
    expect(jwtGeneration(first.accessToken)).toBe(10)
    expect(second.accessToken).toBe(first.accessToken)
  })

  test('save is atomic: no tmp residue and the file always parses (W2.2)', async () => {
    await seedAuthFile(
      tokensWithExpiry(Math.floor(Date.now() / 1000) - 3600, 1),
    )

    await getValidChatGPTAuth()

    const entries = await readdir(configDir)
    // tmp + rename 原子写：落盘后目录里不得残留 .tmp 中间产物。
    expect(entries.filter(name => name.endsWith('.tmp'))).toEqual([])
    const raw = await readFile(
      join(configDir, 'openai-chatgpt-auth.json'),
      'utf8',
    )
    const parsed = JSON.parse(raw) as {
      tokens?: { refresh_token?: string }
    }
    expect(parsed.tokens?.refresh_token).toBe('refresh-token-gen-10')
  })
})
