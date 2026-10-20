import OpenAI from 'openai'
import { openaiAdapter } from 'src/services/providerUsage/adapters/openai.js'
import { updateProviderBuckets } from 'src/services/providerUsage/store.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'

/**
 * Environment variables:
 *
 * OPENAI_API_KEY: Required. API key for the OpenAI-compatible endpoint.
 * OPENAI_BASE_URL: Recommended. Base URL for the endpoint (e.g. http://localhost:11434/v1).
 * OPENAI_ORG_ID: Optional. Organization ID.
 * OPENAI_PROJECT_ID: Optional. Project ID.
 */

/**
 * Cached shared client + the base fetch identity captured at build time.
 *
 * 官方 0032-chunk-dyqmyxqn/module-005-uncategorized.js:706（W1 每请求覆盖面）：
 * `makeRequest` 以 `let s=await e,o=s.maxRetries??this.maxRetries` 起手 ——
 * 重试预算是请求级参数，客户端构造值只是缺省回落；`retryRequest` 的
 * `let a=e.maxRetries??this.maxRetries` 同义。因此共享缓存 client 恒以
 * `maxRetries: 0` 构造（下方 double-billing 契约），请求级预算由调用点经
 * RequestOptions 传入（sideQuery 的 create 第二参），不再有「先建缓存者
 * 的构造参数压住后来者」的吞参数面。
 */
let cachedClient: {
  client: OpenAI
  /** base fetch captured at build time (fetchOverride ?? globalThis.fetch) */
  fetchRef: typeof fetch
} | null = null

/**
 * Wrap a fetch so that every response's rate-limit headers are fed into the
 * provider usage store. Errors in parsing must never break the request.
 *
 * The cast to `typeof fetch` is safe: OpenAI SDK only calls the function form,
 * not the static `preconnect` method that Bun/Node's `fetch` type declares.
 */
function wrapFetchForUsage(base: typeof fetch): typeof fetch {
  const wrapped = async (
    ...args: Parameters<typeof fetch>
  ): Promise<Response> => {
    const res = await base(...args)
    try {
      updateProviderBuckets('openai', openaiAdapter.parseHeaders(res.headers))
    } catch {
      // Ignore — usage tracking must not affect the request path.
    }
    return res
  }
  return wrapped as unknown as typeof fetch
}

export function getOpenAIClient(options?: {
  fetchOverride?: typeof fetch
  source?: string
}): OpenAI {
  // 缓存命中前先做 options 等价校验（W1 修法的「命中前校验」侧）：
  // - 带 fetchOverride 的调用永不参与缓存/不命中缓存 —— 该注入面是
  //   调用方私有（query 的转储包装、测试 hook），旧实现把缓存判断放在
  //   读 options 之前，第二个带 override 的调用点拿到的是先建缓存者的
  //   client，override 被静默丢弃（dumpPrompts fetch 面即此受损）。
  // - 不带 override 时比对进程 fetch 身份：globalThis.fetch 是进程级
  //   可替换面（测试注入/代理运行时切换），捕获过的引用不一致即重建。
  // - maxRetries 因请求级传递（见 cachedClient 注释）不再产生差异面。
  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)
  if (cachedClient && cachedClient.fetchRef === baseFetch) {
    return cachedClient.client
  }

  const apiKey = process.env.OPENAI_API_KEY || ''
  const baseURL = process.env.OPENAI_BASE_URL

  const wrappedFetch = wrapFetchForUsage(baseFetch)

  const client = new OpenAI({
    apiKey,
    ...(baseURL && { baseURL }),
    // Large finite total-duration timeout (headers only — the SDK releases
    // the timer once the response returns and never caps a streaming body).
    // A literal 0 is hazardous: buildRequest treats it as a real value and
    // fetchWithTimeout arms a 0ms abort. Stalled streams are instead guarded
    // by the silence-based idle watchdog (CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS
    // — see streamWatchdog.ts).
    timeout: 600_000,
    // Retries are owned by QueryEngine's fallback state machine — stacked
    // client retries would double-bill relay endpoints. (Non-streaming side
    // queries opt in explicitly per-request via RequestOptions.maxRetries —
    // official 0032:706 `o=s.maxRetries??this.maxRetries`.)
    maxRetries: 0,
    dangerouslyAllowBrowser: true,
    ...(process.env.OPENAI_ORG_ID && {
      organization: process.env.OPENAI_ORG_ID,
    }),
    ...(process.env.OPENAI_PROJECT_ID && {
      project: process.env.OPENAI_PROJECT_ID,
    }),
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    fetch: wrappedFetch,
  })

  // 带 fetchOverride 构建的 client 是调用方私有面，不入缓存。
  if (!options?.fetchOverride) {
    cachedClient = { client, fetchRef: baseFetch }
  }

  return client
}

/** Clear the cached client (useful when env vars change). */
export function clearOpenAIClientCache(): void {
  cachedClient = null
}
