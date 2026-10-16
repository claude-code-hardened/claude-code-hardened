/**
 * Gemini API client — official `@google/genai` SDK wiring.
 *
 * The layer previously hand-rolled fetch + SSE parsing
 * (`streamGenerateContent?alt=sse` with manual `data:` frame decoding) and had
 * no stall protection: a relay that stopped sending bytes left the reader's
 * async frame pending forever, rooting the full request body (measured:
 * 68.6MB/h linear heap growth). The hand-rolled path is deleted — streaming
 * now flows through the official SDK's async iterable, guarded by the same
 * silence-based idle watchdog as the OpenAI layer (see streamWatchdog.ts).
 *
 * Environment variables:
 *
 * GEMINI_API_KEY: Required. Sent by the SDK as the x-goog-api-key header.
 * GEMINI_BASE_URL: Optional. Default
 *   https://generativelanguage.googleapis.com/v1beta. A trailing version
 *   segment (v1beta/v1/v1alpha) is mapped to the SDK's `apiVersion`; a base
 *   without one keeps the old verbatim (version-less) URL layout.
 */

import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  type Candidate as GenaiCandidate,
  type GenerateContentResponse,
  type Part as GenaiPart,
  type ToolConfig,
  type ToolListUnion,
} from '@google/genai'
import type {
  GeminiCandidate,
  GeminiGenerateContentRequest,
  GeminiPart,
  GeminiStreamChunk,
} from '@ant/model-provider'
import { errorMessage } from 'src/utils/errors.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'
const DEFAULT_GEMINI_API_VERSION = 'v1beta'

/**
 * Resolve the endpoint from GEMINI_BASE_URL: split a trailing version segment
 * into the SDK's `apiVersion` so built URLs match the pre-SDK wire format
 * byte-for-byte (`{base}[/{version}]/models/{model}:streamGenerateContent`).
 */
export function getGeminiEndpoint(): {
  baseUrl: string
  apiVersion: string
} {
  const raw = (
    process.env.GEMINI_BASE_URL ||
    `${DEFAULT_GEMINI_BASE_URL}/${DEFAULT_GEMINI_API_VERSION}`
  ).replace(/\/+$/, '')
  const match = raw.match(/\/(v1beta|v1|v1alpha)$/)
  if (match) {
    return { baseUrl: raw.slice(0, -match[0].length), apiVersion: match[1] }
  }
  // Relay base without a version segment: apiVersion '' makes the SDK build
  // URLs as `{base}` + path, exactly like the hand-rolled client did.
  return { baseUrl: raw, apiVersion: '' }
}

/** Wire URL of the streaming call (watchdog registry/diagnostics face). */
export function getGeminiStreamUrl(model: string): string {
  const { baseUrl, apiVersion } = getGeminiEndpoint()
  const normalized = model.replace(/^\/+/, '')
  const modelPath = normalized.startsWith('models/')
    ? normalized
    : `models/${normalized}`
  const suffix = `/${modelPath}:streamGenerateContent?alt=sse`
  return apiVersion
    ? `${baseUrl}/${apiVersion}${suffix}`
    : `${baseUrl}${suffix}`
}

/**
 * Apply the same proxy/mTLS fetch options the hand-rolled path spread onto
 * every request (getProxyFetchOptions on the non-Anthropic face).
 *
 * The cast to `typeof fetch` is safe: the SDK only calls the function form,
 * not the static `preconnect` method that Bun/Node's `fetch` type declares.
 */
function wrapFetchForProxy(base: typeof fetch): typeof fetch {
  const wrapped = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> =>
    base(input, {
      ...init,
      ...getProxyFetchOptions({ forAnthropicAPI: false }),
    })
  return wrapped as unknown as typeof fetch
}

let cachedClient: GoogleGenAI | null = null

/**
 * Build (once) the SDK client. Mirrors getOpenAIClient: no total-duration
 * timeout (a hard cap would kill long healthy streams — the silence-based
 * idle watchdog guards stalls instead) and no SDK-level retries (retry
 * ownership belongs to QueryEngine's fallback state machine).
 */
export function getGeminiClient(options?: {
  fetchOverride?: typeof fetch
}): GoogleGenAI {
  if (cachedClient) return cachedClient

  const { baseUrl, apiVersion } = getGeminiEndpoint()

  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)

  const client = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || '',
    httpOptions: {
      baseUrl,
      // '' keeps the version-less relay layout (see getGeminiEndpoint).
      apiVersion,
      // No total-duration `timeout`: the request cap would misfire on long
      // *healthy* streaming turns, and this SDK has no default (verified in
      // @google/genai 2.30.0 — createAttemptSignal only arms a timer when
      // `timeout > 0`, so an omitted field leaves the stream unbounded).
      // Stalled streams are instead guarded by the silence-based idle
      // watchdog (CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS — streamWatchdog.ts).
      // SDK default is 5 attempts — stacked client retries would double-bill
      // relay endpoints, same reasoning as the OpenAI layer's maxRetries: 0.
      retryOptions: { attempts: 1 },
      fetch: wrapFetchForProxy(baseFetch),
    },
  })

  if (!options?.fetchOverride) {
    cachedClient = client
  }

  return client
}

/** Clear the cached client (useful when env vars change). */
export function clearGeminiClientCache(): void {
  cachedClient = null
}

// The JSON Schema objects produced by anthropicToolsToGemini are opaque wire
// data (REST serializes them verbatim into
// functionDeclarations[].parameters). The SDK types that slot as a concrete
// Schema struct, so the double assertion is the lossless hand-off.
function sdkToolsForBody(body: GeminiGenerateContentRequest): ToolListUnion {
  return body.tools as unknown as ToolListUnion
}

const FUNCTION_CALLING_MODE = {
  AUTO: FunctionCallingConfigMode.AUTO,
  ANY: FunctionCallingConfigMode.ANY,
  NONE: FunctionCallingConfigMode.NONE,
} as const

function sdkToolConfig(
  toolConfig: GeminiGenerateContentRequest['toolConfig'],
): ToolConfig | undefined {
  if (!toolConfig) return undefined
  const { mode, allowedFunctionNames } = toolConfig.functionCallingConfig
  const modeKey = mode ?? 'AUTO'
  return {
    functionCallingConfig: {
      mode: FUNCTION_CALLING_MODE[modeKey],
      ...(allowedFunctionNames && { allowedFunctionNames }),
    },
  }
}

// ─── SDK → GeminiStreamChunk projection (protocol translation must keep the
// existing chunk surface the downstream aggregation logic consumes) ────────

function projectPart(part: GenaiPart): GeminiPart {
  const projected: GeminiPart = {}
  if (part.text !== undefined) projected.text = part.text
  if (part.thought !== undefined) projected.thought = part.thought
  if (part.thoughtSignature !== undefined) {
    projected.thoughtSignature = part.thoughtSignature
  }
  if (part.functionCall) {
    projected.functionCall = {
      ...(part.functionCall.name !== undefined && {
        name: part.functionCall.name,
      }),
      ...(part.functionCall.args !== undefined && {
        args: part.functionCall.args,
      }),
    }
  }
  if (part.functionResponse) {
    projected.functionResponse = {
      ...(part.functionResponse.name !== undefined && {
        name: part.functionResponse.name,
      }),
      ...(part.functionResponse.response !== undefined && {
        response: part.functionResponse.response,
      }),
    }
  }
  if (part.inlineData) {
    projected.inlineData = {
      mimeType: part.inlineData.mimeType ?? '',
      data: part.inlineData.data ?? '',
    }
  }
  return projected
}

function projectCandidate(candidate: GenaiCandidate): GeminiCandidate {
  return {
    ...(candidate.index !== undefined && { index: candidate.index }),
    ...(candidate.finishReason !== undefined && {
      finishReason: candidate.finishReason,
    }),
    content: candidate.content
      ? {
          ...(candidate.content.role !== undefined && {
            role: candidate.content.role,
          }),
          ...(candidate.content.parts && {
            parts: candidate.content.parts.map(projectPart),
          }),
        }
      : undefined,
  }
}

function projectChunk(response: GenerateContentResponse): GeminiStreamChunk {
  return {
    ...(response.candidates && {
      candidates: response.candidates.map(projectCandidate),
    }),
    ...(response.usageMetadata && {
      usageMetadata: {
        promptTokenCount: response.usageMetadata.promptTokenCount,
        candidatesTokenCount: response.usageMetadata.candidatesTokenCount,
        thoughtsTokenCount: response.usageMetadata.thoughtsTokenCount,
        totalTokenCount: response.usageMetadata.totalTokenCount,
        cachedContentTokenCount: response.usageMetadata.cachedContentTokenCount,
      },
    }),
    ...(response.modelVersion !== undefined && {
      modelVersion: response.modelVersion,
    }),
  }
}

/**
 * Stream Gemini generateContent through the official SDK. Same surface as the
 * pre-SDK hand-rolled client: yields the raw wire chunks (GeminiStreamChunk)
 * the aggregation/translation logic in @ant/model-provider consumes.
 *
 * `signal` should be the watchdog's signal (see streamWatchdog.ts) — it is
 * passed as config.abortSignal so the watchdog can tear the stuck request
 * down; the session-level signal stays linked into the watchdog itself.
 */
export async function* streamGeminiGenerateContent(params: {
  model: string
  body: GeminiGenerateContentRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
}): AsyncGenerator<GeminiStreamChunk, void> {
  const client = getGeminiClient({ fetchOverride: params.fetchOverride })
  const generationConfig = params.body.generationConfig
  const thinking = generationConfig?.thinkingConfig
  const toolConfig = sdkToolConfig(params.body.toolConfig)
  const bodyTools = params.body.tools
  const sdkTools =
    bodyTools && bodyTools.length > 0
      ? sdkToolsForBody(params.body)
      : undefined

  let stream: AsyncGenerator<GenerateContentResponse>
  try {
    stream = await client.models.generateContentStream({
      model: params.model,
      // GeminiContent[] is structurally the SDK's ContentListUnion.
      contents: params.body.contents,
      config: {
        ...(params.body.systemInstruction && {
          systemInstruction: params.body.systemInstruction,
        }),
        ...(sdkTools && { tools: sdkTools }),
        ...(toolConfig && { toolConfig }),
        ...(generationConfig?.temperature !== undefined && {
          temperature: generationConfig.temperature,
        }),
        ...(thinking && {
          thinkingConfig: {
            ...(thinking.includeThoughts !== undefined && {
              includeThoughts: thinking.includeThoughts,
            }),
            ...(thinking.thinkingBudget !== undefined && {
              thinkingBudget: thinking.thinkingBudget,
            }),
          },
        }),
        // The hand-rolled client issued exactly one request; the SDK's
        // automatic continuation-token resumption (default on) would hide
        // follow-up requests under the hood where neither the watchdog nor
        // QueryEngine's retry accounting can see them.
        automaticContinuation: false,
        // Watchdog aborts through this signal (idle timeout + session abort).
        abortSignal: params.signal,
      },
    })
  } catch (error) {
    throw new Error(
      `Gemini API stream request failed: ${errorMessage(error)}`,
    )
  }

  for await (const response of stream) {
    yield projectChunk(response)
  }
}
