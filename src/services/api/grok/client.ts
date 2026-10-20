import OpenAI from 'openai'
import { getProxyFetchOptions } from 'src/utils/proxy.js'

/**
 * Environment variables:
 *
 * GROK_API_KEY (or XAI_API_KEY): Required. API key for the xAI Grok endpoint.
 * GROK_BASE_URL: Optional. Defaults to https://api.x.ai/v1.
 */

const DEFAULT_BASE_URL = 'https://api.x.ai/v1'

/**
 * Cached shared client + the base fetch identity captured at build time.
 *
 * 官方 0032-chunk-dyqmyxqn/module-005-uncategorized.js:706（W1 每请求覆盖面）：
 * `makeRequest` 以 `let s=await e,o=s.maxRetries??this.maxRetries` 起手 ——
 * 重试预算是请求级参数，客户端构造值只是缺省回落。因此共享缓存 client 恒以
 * `maxRetries: 0` 构造（QueryEngine 独占重试所有权，双层叠加会重复扣费），
 * 请求级预算由调用点经 RequestOptions 传入（sideQuery 的 create 第二参）。
 */
let cachedClient: {
  client: OpenAI
  /** base fetch captured at build time (fetchOverride ?? globalThis.fetch) */
  fetchRef: typeof fetch
} | null = null

export function getGrokClient(options?: {
  fetchOverride?: typeof fetch
  source?: string
}): OpenAI {
  // 缓存命中前 options 等价校验（W1）：带 fetchOverride 的调用永不命中/
  // 不入缓存（注入面是调用方私有——query 转储包装、测试 hook；旧实现把
  // 缓存判断放在读 options 之前，override 会被先建缓存者的 client 静默
  // 吞掉）；不带 override 时比对进程 fetch 身份（globalThis.fetch 可被
  // 测试/代理链路整体替换，捕获引用不一致即重建）。
  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)
  if (cachedClient && cachedClient.fetchRef === baseFetch) {
    return cachedClient.client
  }

  const apiKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY || ''
  const baseURL = process.env.GROK_BASE_URL || DEFAULT_BASE_URL

  const client = new OpenAI({
    apiKey,
    baseURL,
    // Request-level budget only (see cachedClient comment): the shared
    // client itself never retries.
    maxRetries: 0,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    ...(options?.fetchOverride && { fetch: options.fetchOverride }),
  })

  if (!options?.fetchOverride) {
    cachedClient = { client, fetchRef: baseFetch }
  }

  return client
}

export function clearGrokClientCache(): void {
  cachedClient = null
}
