/**
 * Tests for the Gemini client's SDK wiring.
 *
 * The hand-rolled fetch/SSE client is gone: these tests pin the
 * @google/genai SDK fake surface — constructor options (no total timeout,
 * SDK retries off, endpoint mapping of GEMINI_BASE_URL), the body→config
 * translation performed by streamGeminiGenerateContent, the
 * GenerateContentResponse → GeminiStreamChunk projection, and the
 * idle-watchdog integration at the client seam.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { debugMock } from '../../../../../tests/mocks/debug'
import type { GeminiStreamChunk } from '@ant/model-provider'

mock.module('../../../../utils/debug.js', () => debugMock())

// ─── @google/genai fake surface ──────────────────────────────────────────────

type RecordedStreamCall = {
  model: unknown
  contents: unknown
  config: Record<string, unknown> | undefined
}

const fakeState = {
  ctorOptions: [] as Array<Record<string, unknown>>,
  streamCalls: [] as RecordedStreamCall[],
  streamFactory: null as null | (() => AsyncIterable<unknown>),
}

class FakeModels {
  async generateContentStream(params: {
    model: unknown
    contents: unknown
    config?: Record<string, unknown>
  }) {
    fakeState.streamCalls.push({
      model: params.model,
      contents: params.contents,
      config: params.config,
    })
    if (!fakeState.streamFactory) {
      throw new Error('fake streamFactory not configured')
    }
    return fakeState.streamFactory()
  }
}

class FakeGoogleGenAI {
  models: FakeModels
  constructor(options: Record<string, unknown>) {
    fakeState.ctorOptions.push(options)
    this.models = new FakeModels()
  }
}

mock.module('@google/genai', () => ({
  GoogleGenAI: FakeGoogleGenAI,
  FunctionCallingConfigMode: {
    MODE_UNSPECIFIED: 'MODE_UNSPECIFIED',
    AUTO: 'AUTO',
    ANY: 'ANY',
    NONE: 'NONE',
  },
}))

type ClientModule = typeof import('../client.js')
type WatchdogModule = typeof import('../streamWatchdog.js')

async function loadClient(): Promise<ClientModule> {
  return await import('../client.js')
}

async function loadWatchdog(): Promise<WatchdogModule> {
  return await import('../streamWatchdog.js')
}

// ─── env/cache hygiene ───────────────────────────────────────────────────────

const IDLE_ENV = 'CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS'
const ENV_KEYS = ['GEMINI_API_KEY', 'GEMINI_BASE_URL', IDLE_ENV]

function setEnv(key: string, value: string): void {
  process.env[key] = value
}

beforeEach(async () => {
  const { clearGeminiClientCache } = await loadClient()
  clearGeminiClientCache()
  fakeState.ctorOptions = []
  fakeState.streamCalls = []
  fakeState.streamFactory = null
  delete process.env[IDLE_ENV]
})

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

// ─── endpoint mapping ────────────────────────────────────────────────────────

describe('getGeminiEndpoint / getGeminiStreamUrl', () => {
  test('default endpoint keeps the generativelanguage v1beta layout', async () => {
    const { getGeminiEndpoint, getGeminiStreamUrl } = await loadClient()
    delete process.env.GEMINI_BASE_URL

    expect(getGeminiEndpoint()).toEqual({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiVersion: 'v1beta',
    })
    expect(getGeminiStreamUrl('gemini-2.5-pro')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    )
  })

  test('relay base with a version segment is split into baseUrl + apiVersion', async () => {
    const { getGeminiEndpoint, getGeminiStreamUrl } = await loadClient()
    setEnv('GEMINI_BASE_URL', 'https://relay.example/v1beta/')

    expect(getGeminiEndpoint()).toEqual({
      baseUrl: 'https://relay.example',
      apiVersion: 'v1beta',
    })
    expect(getGeminiStreamUrl('models/gemini-2.5-pro')).toBe(
      'https://relay.example/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    )
  })

  test('version-less relay base keeps the verbatim (version-less) wire path', async () => {
    const { getGeminiEndpoint, getGeminiStreamUrl } = await loadClient()
    setEnv('GEMINI_BASE_URL', 'http://127.0.0.1:17892')

    expect(getGeminiEndpoint()).toEqual({
      baseUrl: 'http://127.0.0.1:17892',
      apiVersion: '',
    })
    expect(getGeminiStreamUrl('gemini-2.5-pro')).toBe(
      'http://127.0.0.1:17892/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    )
  })
})

// ─── client factory ──────────────────────────────────────────────────────────

describe('getGeminiClient', () => {
  test('wires the SDK with no total timeout, SDK retries off, and the endpoint', async () => {
    const { getGeminiClient } = await loadClient()
    setEnv('GEMINI_API_KEY', 'test-key')
    setEnv('GEMINI_BASE_URL', 'https://relay.example/v1beta')

    getGeminiClient()

    expect(fakeState.ctorOptions).toHaveLength(1)
    const ctor = fakeState.ctorOptions[0]
    expect(ctor.apiKey).toBe('test-key')
    const httpOptions = ctor.httpOptions as Record<string, unknown>
    expect(httpOptions.baseUrl).toBe('https://relay.example')
    expect(httpOptions.apiVersion).toBe('v1beta')
    // No total-duration `timeout`: the field must be omitted entirely
    // (verified in @google/genai — createAttemptSignal only arms a timer
    // when `timeout > 0`, and no default exists).
    expect('timeout' in httpOptions).toBe(false)
    // QueryEngine owns retries — SDK-level retries must be off.
    expect(httpOptions.retryOptions).toEqual({ attempts: 1 })
    expect(typeof httpOptions.fetch).toBe('function')
  })

  test('caches the client until clearGeminiClientCache', async () => {
    const { getGeminiClient, clearGeminiClientCache } = await loadClient()
    setEnv('GEMINI_API_KEY', 'test-key')

    const first = getGeminiClient()
    expect(getGeminiClient()).toBe(first)

    clearGeminiClientCache()
    expect(getGeminiClient()).not.toBe(first)
  })

  test('fetchOverride bypasses the cache', async () => {
    const { getGeminiClient } = await loadClient()
    setEnv('GEMINI_API_KEY', 'test-key')

    const a = getGeminiClient({ fetchOverride: async () => new Response() })
    const b = getGeminiClient({ fetchOverride: async () => new Response() })
    expect(a).not.toBe(b)
  })
})

// ─── body → SDK config translation ──────────────────────────────────────────

const BASE_URL_ENV = 'https://relay.example/v1beta'

function bodyOverrides(): Record<string, unknown> {
  return {
    contents: [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi' }] },
    ],
    systemInstruction: { parts: [{ text: 'be brief' }] },
    tools: [
      {
        functionDeclarations: [
          { name: 'bash', description: 'run', parameters: { type: 'object' } },
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['bash'],
      },
    },
    generationConfig: {
      temperature: 0.5,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
    },
  }
}

describe('streamGeminiGenerateContent (SDK face)', () => {
  test('translates the wire body onto the SDK config and passes the signal', async () => {
    const { streamGeminiGenerateContent } = await loadClient()
    setEnv('GEMINI_API_KEY', 'test-key')
    setEnv('GEMINI_BASE_URL', BASE_URL_ENV)
    fakeState.streamFactory = () => emptySdkStream()

    const body = bodyOverrides()
    const controller = new AbortController()
    const stream = streamGeminiGenerateContent({
      model: 'gemini-2.5-pro',
      body: body as never,
      signal: controller.signal,
    })
    // Async generators are lazy — pull once to drive the SDK call.
    for await (const _chunk of stream) {
      // no chunks expected
      break
    }

    expect(fakeState.streamCalls).toHaveLength(1)
    const call = fakeState.streamCalls[0]
    expect(call.model).toBe('gemini-2.5-pro')
    expect(call.contents).toBe(body.contents)
    const config = call.config as Record<string, unknown>
    expect(config.systemInstruction).toBe(body.systemInstruction)
    expect(config.tools).toBe(body.tools)
    expect(config.toolConfig).toEqual({
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['bash'],
      },
    })
    // generationConfig.* is flattened onto the SDK config face.
    expect(config.temperature).toBe(0.5)
    expect(config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 1024,
    })
    // Single-request semantics + watchdog abort path.
    expect(config.automaticContinuation).toBe(false)
    expect(config.abortSignal).toBe(controller.signal)
  })

  test('omits absent body fields from the SDK config', async () => {
    const { streamGeminiGenerateContent } = await loadClient()
    setEnv('GEMINI_API_KEY', 'test-key')
    fakeState.streamFactory = () => emptySdkStream()

    const stream = streamGeminiGenerateContent({
      model: 'gemini-2.5-pro',
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      signal: new AbortController().signal,
    })
    for await (const _chunk of stream) break

    const config = fakeState.streamCalls[0].config as Record<string, unknown>
    expect('systemInstruction' in config).toBe(false)
    expect('tools' in config).toBe(false)
    expect('toolConfig' in config).toBe(false)
    expect('temperature' in config).toBe(false)
    expect('thinkingConfig' in config).toBe(false)
  })

  test('wraps SDK stream-construction errors with a recognizable message', async () => {
    const { streamGeminiGenerateContent } = await loadClient()
    setEnv('GEMINI_API_KEY', 'test-key')
    fakeState.streamFactory = () => {
      throw new Error('relay 502: upstream connect error')
    }

    const stream = streamGeminiGenerateContent({
      model: 'gemini-2.5-pro',
      body: { contents: [] },
      signal: new AbortController().signal,
    })

    let caught: unknown = null
    try {
      for await (const _chunk of stream) break
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain('Gemini API stream request failed')
    expect(message).toContain('relay 502: upstream connect error')
  })
})

// ─── GenerateContentResponse → GeminiStreamChunk projection ─────────────────

function makeSdkChunk(overrides: Record<string, unknown>): unknown {
  return { ...overrides }
}

/** SDK fake that yields the given chunks then ends. */
function sdkStreamOf(chunks: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

/** SDK fake that emits one chunk and then never settles (stuck relay). */
function stalledSdkStream(firstChunk: unknown): AsyncIterable<unknown> {
  async function* stalled() {
    yield firstChunk
    await new Promise<never>(() => {})
  }
  return stalled()
}

/** SDK fake that ends immediately. */
function emptySdkStream(): AsyncIterable<unknown> {
  return (async function* () {})()
}

describe('chunk projection', () => {
  test('projects candidates parts (text/thought/functionCall) and usage', async () => {
    const { streamGeminiGenerateContent } = await loadClient()
    setEnv('GEMINI_API_KEY', 'test-key')
    const firstChunk = makeSdkChunk({
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              { text: 'thinking hard', thought: true },
              { text: 'hello world' },
              {
                functionCall: { name: 'bash', args: { cmd: 'ls' } },
                thoughtSignature: 'sig-123',
              },
            ],
          },
        },
      ],
    })
    const secondChunk = makeSdkChunk({
      candidates: [
        { index: 0, finishReason: 'STOP', content: { role: 'model' } },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 3,
        totalTokenCount: 18,
        cachedContentTokenCount: 2,
      },
      modelVersion: 'gemini-2.5-pro-001',
    })
    fakeState.streamFactory = () => sdkStreamOf([firstChunk, secondChunk])

    const stream = streamGeminiGenerateContent({
      model: 'gemini-2.5-pro',
      body: { contents: [] },
      signal: new AbortController().signal,
    })

    const chunks: GeminiStreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              { text: 'thinking hard', thought: true },
              { text: 'hello world' },
              {
                functionCall: { name: 'bash', args: { cmd: 'ls' } },
                thoughtSignature: 'sig-123',
              },
            ],
          },
        },
      ],
      usageMetadata: undefined,
    })

    expect(chunks[1]).toEqual({
      candidates: [
        {
          index: 0,
          finishReason: 'STOP',
          content: { role: 'model' },
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 3,
        totalTokenCount: 18,
        cachedContentTokenCount: 2,
      },
      modelVersion: 'gemini-2.5-pro-001',
    })
  })
})

// ─── watchdog integration at the client seam ─────────────────────────────────

describe('idle watchdog over the SDK stream', () => {
  test('aborts a stalled SDK stream, lands the structured error, settles the registry', async () => {
    const { streamGeminiGenerateContent, getGeminiStreamUrl } =
      await loadClient()
    const { createStreamWatchdog, getInFlightApiRequests } =
      await loadWatchdog()
    const { StreamIdleTimeoutError } = await loadWatchdog()
    setEnv('GEMINI_API_KEY', 'test-key')
    setEnv(IDLE_ENV, '50')

    const watchdog = createStreamWatchdog({
      url: getGeminiStreamUrl('gemini-2.5-pro'),
      model: 'gemini-2.5-pro',
      externalSignal: new AbortController().signal,
    })
    // Frozen generator: next() already resolved, but the SDK's follow-up
    // read never settles — the surface a stuck relay exposes.
    fakeState.streamFactory = () => {
      async function* stalled() {
        yield makeSdkChunk({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'start' }] } },
          ],
        })
        await new Promise<never>(() => {})
      }
      return stalled() as AsyncIterable<unknown>
    }

    const wrapped = watchdog.wrap(
      streamGeminiGenerateContent({
        model: 'gemini-2.5-pro',
        body: { contents: [] },
        signal: watchdog.signal,
      }),
    )

    const chunks: GeminiStreamChunk[] = []
    let error: unknown = null
    try {
      for await (const chunk of wrapped) chunks.push(chunk)
    } catch (caught) {
      error = caught
    }

    expect(chunks).toHaveLength(1)
    expect(error).toBeInstanceOf(StreamIdleTimeoutError)
    expect(watchdog.signal.aborted).toBe(true)
    // Registry entry is settled by the wrapped stream's finally.
    const { getInFlightApiRequests: registry } = await loadWatchdog()
    expect(
      registry().find(e => e.requestId === watchdog.requestId),
    ).toBeUndefined()
  })

  test('a healthy SDK stream is fully consumed below the silence window', async () => {
    const { streamGeminiGenerateContent, getGeminiStreamUrl } =
      await loadClient()
    const { createStreamWatchdog, getInFlightApiRequests } =
      await loadWatchdog()
    setEnv('GEMINI_API_KEY', 'test-key')
    setEnv(IDLE_ENV, '5000')

    const watchdog = createStreamWatchdog({
      url: getGeminiStreamUrl('gemini-2.5-pro'),
      model: 'gemini-2.5-pro',
      externalSignal: new AbortController().signal,
    })
    fakeState.streamFactory = () =>
      (async function* () {
        yield makeSdkChunk({
          candidates: [{ content: { role: 'model', parts: [{ text: 'a' }] } }],
        })
        yield makeSdkChunk({
          candidates: [{ finishReason: 'STOP' }],
        })
      })() as AsyncIterable<unknown>

    const wrapped = watchdog.wrap(
      streamGeminiGenerateContent({
        model: 'gemini-2.5-pro',
        body: { contents: [] },
        signal: watchdog.signal,
      }),
    )

    const chunks: GeminiStreamChunk[] = []
    let error: unknown = null
    try {
      for await (const chunk of wrapped) chunks.push(chunk)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeNull()
    expect(chunks).toHaveLength(2)
    expect(watchdog.signal.aborted).toBe(false)
    expect(
      getInFlightApiRequests().find(e => e.requestId === watchdog.requestId),
    ).toBeUndefined()
  })

  test('timeout=0 disables the watchdog (stall survives the grace window)', async () => {
    const { streamGeminiGenerateContent, getGeminiStreamUrl } =
      await loadClient()
    const { createStreamWatchdog, getInFlightApiRequests } =
      await loadWatchdog()
    setEnv('GEMINI_API_KEY', 'test-key')
    setEnv(IDLE_ENV, '0')

    const watchdog = createStreamWatchdog({
      url: getGeminiStreamUrl('gemini-2.5-pro'),
      model: 'gemini-2.5-pro',
      externalSignal: new AbortController().signal,
    })
    fakeState.streamFactory = () => {
      async function* stalled() {
        yield makeSdkChunk({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'start' }] } },
          ],
        })
        await new Promise<never>(() => {})
      }
      return stalled() as AsyncIterable<unknown>
    }

    const wrapped = watchdog.wrap(
      streamGeminiGenerateContent({
        model: 'gemini-2.5-pro',
        body: { contents: [] },
        signal: watchdog.signal,
      }),
    )

    async function drain(): Promise<void> {
      for await (const _chunk of wrapped) {
        // never settles
      }
    }
    void drain()
    // Give the consumption loop a beat; nothing may abort while disabled.
    await new Promise<void>(resolve => setTimeout(resolve, 120))

    expect(watchdog.signal.aborted).toBe(false)
    // Caller contract covers teardown when watchdog is disabled.
    watchdog.settle()
    expect(
      getInFlightApiRequests().find(e => e.requestId === watchdog.requestId),
    ).toBeUndefined()
  })
})
