import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { logForDebugging } from 'src/utils/debug.js'

const ISSUER = 'https://auth.openai.com'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_FILE = 'openai-chatgpt-auth.json'
const REFRESH_SKEW_MS = 5 * 60 * 1000

export type ChatGPTDeviceCode = {
  verificationUrl: string
  userCode: string
  deviceAuthId: string
  intervalSeconds: number
}

export type ChatGPTAuthTokens = {
  idToken: string
  accessToken: string
  refreshToken: string
  accountId?: string
  lastRefresh?: string
}

export type ChatGPTAuth = {
  accessToken: string
  accountId?: string
}

type StoredAuthFile = {
  auth_mode?: string
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
}

function authFilePath(): string {
  return join(getClaudeConfigHomeDirLocal(), AUTH_FILE)
}

function getClaudeConfigHomeDirLocal(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  ).normalize('NFC')
}

function codexAuthFilePath(): string {
  return join(
    process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex'),
    'auth.json',
  )
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseJSONRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.')
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '=',
    )
    const json = Buffer.from(padded, 'base64').toString('utf8')
    return parseJSONRecord(json)
  } catch {
    return null
  }
}

function getOpenAIAuthClaims(token: string): Record<string, unknown> {
  const payload = decodeJwtPayload(token)
  const nested = payload?.['https://api.openai.com/auth']
  if (nested && typeof nested === 'object') {
    return nested as Record<string, unknown>
  }
  return payload ?? {}
}

function getTokenExpiryMs(token: string): number | null {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  return typeof exp === 'number' ? exp * 1000 : null
}

function extractAccountId(tokens: {
  idToken?: string
  accessToken?: string
  accountId?: string
}): string | undefined {
  if (tokens.accountId) return tokens.accountId
  for (const token of [tokens.idToken, tokens.accessToken]) {
    if (!token) continue
    const claims = getOpenAIAuthClaims(token)
    const accountId =
      asString(claims.chatgpt_account_id) ??
      asString(claims.chatgpt_account_user_id) ??
      asString(claims.account_id)
    if (accountId) return accountId
  }
  return undefined
}

async function readStoredAuth(path: string): Promise<ChatGPTAuthTokens | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as StoredAuthFile
    const tokens = parsed.tokens
    const idToken = tokens?.id_token
    const accessToken = tokens?.access_token
    const refreshToken = tokens?.refresh_token
    if (!idToken || !accessToken || !refreshToken) return null
    return {
      idToken,
      accessToken,
      refreshToken,
      accountId: extractAccountId({
        idToken,
        accessToken,
        accountId: tokens.account_id,
      }),
      lastRefresh: parsed.last_refresh,
    }
  } catch {
    return null
  }
}

async function saveStoredAuth(tokens: ChatGPTAuthTokens): Promise<void> {
  const path = authFilePath()
  await mkdir(getClaudeConfigHomeDirLocal(), { recursive: true })
  const body: StoredAuthFile = {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: extractAccountId(tokens),
    },
    last_refresh: new Date().toISOString(),
  }
  // 原子写（W2.2 修法）：先写同目录 tmp 再 rename。直接 writeFile 有两个
  // 受损面——读取方看到半截 JSON（torn read），以及与外部写入者（codex
  // CLI 同盘写 auth 文件族）交叠时新值被截断覆盖。rename 在 POSIX 上对
  // 同目录目标是原子的，读侧永远看到完整旧值或完整新值。
  // 权限在 rename 前落到 tmp 上：0600 面无窗口期暴露。
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmpPath, `${JSON.stringify(body, null, 2)}\n`, {
      mode: 0o600,
    })
    await chmod(tmpPath, 0o600).catch(() => undefined)
    await rename(tmpPath, path)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function postJSON<T>(
  url: string,
  body: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`ChatGPT auth request failed (${res.status})`)
  }
  return (await res.json()) as T
}

async function postForm<T>(url: string, body: URLSearchParams): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `ChatGPT token request failed (${res.status})${text ? `: ${text}` : ''}`,
    )
  }
  return (await res.json()) as T
}

export async function requestChatGPTDeviceCode(): Promise<ChatGPTDeviceCode> {
  type UserCodeResponse = {
    device_auth_id: string
    user_code?: string
    usercode?: string
    interval?: string | number
  }
  const data = await postJSON<UserCodeResponse>(
    `${ISSUER}/api/accounts/deviceauth/usercode`,
    { client_id: CLIENT_ID },
  )
  const userCode = data.user_code ?? data.usercode
  if (!data.device_auth_id || !userCode) {
    throw new Error('ChatGPT auth response did not include a device code')
  }
  const interval =
    typeof data.interval === 'number'
      ? data.interval
      : Number.parseInt(data.interval ?? '5', 10)
  return {
    verificationUrl: `${ISSUER}/codex/device`,
    userCode,
    deviceAuthId: data.device_auth_id,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 5,
  }
}

async function pollForAuthorizationCode(
  deviceCode: ChatGPTDeviceCode,
  signal?: AbortSignal,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  type TokenPollResponse = {
    authorization_code: string
    code_verifier: string
  }
  const started = Date.now()
  while (Date.now() - started < 15 * 60 * 1000) {
    if (signal?.aborted) throw new Error('ChatGPT login cancelled')
    const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceCode.deviceAuthId,
        user_code: deviceCode.userCode,
      }),
      signal,
    })
    if (res.ok) {
      const data = (await res.json()) as TokenPollResponse
      return {
        authorizationCode: data.authorization_code,
        codeVerifier: data.code_verifier,
      }
    }
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(`ChatGPT device auth failed (${res.status})`)
    }
    await new Promise(resolve =>
      setTimeout(resolve, deviceCode.intervalSeconds * 1000),
    )
  }
  throw new Error('ChatGPT device auth timed out after 15 minutes')
}

async function exchangeAuthorizationCode(params: {
  authorizationCode: string
  codeVerifier: string
}): Promise<ChatGPTAuthTokens> {
  type TokenResponse = {
    id_token: string
    access_token: string
    refresh_token: string
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.authorizationCode,
    redirect_uri: `${ISSUER}/deviceauth/callback`,
    client_id: CLIENT_ID,
    code_verifier: params.codeVerifier,
  })
  const data = await postForm<TokenResponse>(`${ISSUER}/oauth/token`, body)
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accountId: extractAccountId({
      idToken: data.id_token,
      accessToken: data.access_token,
    }),
  }
}

async function refreshTokens(
  tokens: ChatGPTAuthTokens,
): Promise<ChatGPTAuthTokens> {
  type TokenResponse = {
    id_token: string
    access_token: string
    refresh_token?: string
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: CLIENT_ID,
    scope:
      'openid profile email offline_access api.connectors.read api.connectors.invoke',
  })
  const data = await postForm<TokenResponse>(`${ISSUER}/oauth/token`, body)
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    accountId: extractAccountId({
      idToken: data.id_token,
      accessToken: data.access_token,
      accountId: tokens.accountId,
    }),
  }
}

export async function completeChatGPTDeviceLogin(
  deviceCode: ChatGPTDeviceCode,
  signal?: AbortSignal,
): Promise<ChatGPTAuthTokens> {
  const code = await pollForAuthorizationCode(deviceCode, signal)
  const tokens = await exchangeAuthorizationCode(code)
  await saveStoredAuth(tokens)
  return tokens
}

export function isChatGPTAuthEnabled(): boolean {
  return process.env.OPENAI_AUTH_MODE === 'chatgpt'
}

export async function removeChatGPTAuth(): Promise<void> {
  await unlink(authFilePath()).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  })
}

// ─── Token cache face（W2.1 / W2.4：官方 Egt 等价，0032-chunk-dyqmyxqn/
// module-002-class-hierarchy.js:7 + module-005-uncategorized.js:692 原文）───
// 官方 `class Egt{...this.cached=null,this.pendingRefresh=null,this.
// nextForce=!1,...}`：
//   invalidate(){this.cached=null,this.nextForce=!0}            — W2.4
//   refresh(e=!1){if(this.pendingRefresh&&!e)return this.
//     pendingRefresh;return this.doRefresh(e)}                  — W2.1 单飞
// CCH 的 token cache 落在磁盘文件（getValidChatGPTAuth 每次读盘），对应
// 面为：pendingRefresh = 进程内共享刷新 Promise（并发调用者挂同一解析）、
// nextForce = 强制刷新标志（401 invalidate 后下一次读取强制走 refreshTokens，
// 非未过期 token 原样重发）、原子写 = saveStoredAuth 的 tmp+rename。
let pendingTokenRefresh: Promise<ChatGPTAuthTokens> | null = null
let forceNextTokenRefresh = false

/**
 * W2.4 invalidate 面：官方 `tokenCache.invalidate()` 的
 * `this.cached=null,this.nextForce=!0` 等价——下一次
 * getValidChatGPTAuth() 不看过期曲线，强制经 refreshTokens 换新
 * （被吊销但未过期的 token 不能原样重发）。当前进程内无 token memo，
 * 「丢缓存」即由此标志承载。
 */
export function invalidateChatGPTTokenCache(): void {
  forceNextTokenRefresh = true
}

/**
 * W2.1 单飞（官方 Egt.refresh 原文：`if(this.pendingRefresh&&!e)return
 * this.pendingRefresh;return this.doRefresh(e)`）：并发调用共享同一解析
 * Promise——首个读盘发现过期/被强制的调用者发起刷新并落盘，其余调用者
 * await 同一 Promise 拿同一份新 token。旧实现并发各自刷新：第二个刷新
 * 用已被第一个轮换掉的 refresh_token 发起（服务端可能直接吊销会话），
 * 且交叠的 writeFile 可让旧值落盘晚于新值。force 面忠于官方：强制刷新
 * 不并入非强制的 pending（`!e` 门），起新的 doRefresh（provider 带
 * forceRefresh:!0 的 CCH 对应即不看缓存直接刷新）。
 */
async function refreshAndStoreTokens(
  tokens: ChatGPTAuthTokens,
  force: boolean,
): Promise<ChatGPTAuthTokens> {
  if (pendingTokenRefresh && !force) {
    return pendingTokenRefresh
  }
  const pending = (async () => {
    const fresh = await refreshTokens(tokens)
    await saveStoredAuth(fresh)
    return fresh
  })()
  pendingTokenRefresh = pending
  // doRefresh 的清算面（`this.pendingRefresh=null`）：只清自己名下的
  // pending（force 覆盖场景下后来者已在槽位上，先行者不得越权抹除）。
  // catch 只为吞掉 derived promise 的二次未处理拒绝——原始拒绝仍由
  // 调用方经返回值感知（官方解析错误传播面）。
  void pending
    .finally(() => {
      if (pendingTokenRefresh === pending) {
        pendingTokenRefresh = null
      }
    })
    .catch(() => undefined)
  return pending
}

export async function getValidChatGPTAuth(): Promise<ChatGPTAuth> {
  // 官方 Egt.getToken 原文：`let e=this.nextForce;this.nextForce=!1;...`
  // —— force 标志读后即清（consume-once）。
  const force = forceNextTokenRefresh
  forceNextTokenRefresh = false
  let tokens = await readStoredAuth(authFilePath())
  if (!tokens) {
    tokens = await readStoredAuth(codexAuthFilePath())
    if (tokens) {
      logForDebugging('[OpenAI] Using ChatGPT auth from Codex auth.json')
    }
  }
  if (!tokens) {
    throw new Error(
      'ChatGPT account is not logged in. Run /login and select ChatGPT account with subscription.',
    )
  }
  const expiresAt = getTokenExpiryMs(tokens.accessToken)
  if (
    force ||
    (expiresAt !== null && expiresAt <= Date.now() + REFRESH_SKEW_MS)
  ) {
    tokens = await refreshAndStoreTokens(tokens, force)
  }
  return {
    accessToken: tokens.accessToken,
    accountId: tokens.accountId ?? extractAccountId(tokens),
  }
}
