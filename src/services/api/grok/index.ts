import type {
  BetaToolUnion,
  BetaMessage,
  BetaUsage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type {
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  AssistantMessage,
} from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions/completions.mjs'
import { getGrokClient } from './client.js'
import { createStreamWatchdog } from '../openai/streamWatchdog.js'
import { withConnectionRetry } from 'src/services/api/connectionRetry.js'
import type { ConnectionRetryStatus } from 'src/services/api/connectionRetry.js'
import { retryStatusMessage } from 'src/services/api/connectionRetry.js'
import {
  releaseOnStreamEnd,
  withProviderSlot,
} from 'src/services/api/providerConcurrency.js'
import { updateOpenAIUsage } from '../openai/openaiShared.js'
import {
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  adaptOpenAIStreamToAnthropic,
  resolveGrokModel,
} from '@ant/model-provider'
import { normalizeMessagesForAPI } from '../../../utils/messages.js'
import type { SDKAssistantMessageError } from '../../../entrypoints/agentSdkTypes.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { logForDebugging } from '../../../utils/debug.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../../services/langfuse/convert.js'
import type { Options } from '../claude.js'
import { randomUUID } from 'crypto'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
} from '../../../utils/messages.js'

/**
 * "Retrying-in" surfaces for the connection retry layer. The debug line
 * keeps the historical trace; `retryStatusMessage` renders the official
 * system/api_error row ("Retrying in Xs… (attempt n/N)"). Establishment
 * retries happen before any stream event exists and the retry loop runs
 * inside an awaited callback, so the generator cannot yield mid-await —
 * each notice is buffered and replayed into the message stream right after
 * the stream is secured.
 */
function logRetryIn({
  attempt,
  maxRetries,
  retryInMs,
}: ConnectionRetryStatus): void {
  logForDebugging(
    `[Grok] Retrying-in ${Math.round(retryInMs / 100) / 10}s ` +
      `(attempt ${attempt}/${maxRetries})`,
  )
}

function collectRetryStatus(
  notices: SystemAPIErrorMessage[],
): (status: ConnectionRetryStatus) => void {
  return status => {
    logRetryIn(status)
    notices.push(retryStatusMessage(status))
  }
}

/**
 * Grok (xAI) query path. Grok uses an OpenAI-compatible API, so we reuse
 * the OpenAI message/tool converters and stream adapter. Only the client
 * (different base URL + API key) and model mapping are Grok-specific.
 */
export async function* queryModelGrok(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  try {
    const grokModel = resolveGrokModel(options.model)
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)

    const toolSchemas = await Promise.all(
      tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
        }),
      ),
    )
    const standardTools: BetaToolUnion[] = toolSchemas.filter(
      (t): t is BetaToolUnion & { type: string } => {
        const anyT = t as unknown as Record<string, unknown>
        return (
          anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
        )
      },
    )

    const openaiMessages = anthropicMessagesToOpenAI(
      messagesForAPI,
      systemPrompt,
    )
    const openaiTools = anthropicToolsToOpenAI(standardTools)
    const openaiToolChoice = anthropicToolChoiceToOpenAI(options.toolChoice)

    // maxRetries 不在构造面下达（官方 0032:706 每请求覆盖语义）——共享
    // 缓存 client 恒以 maxRetries:0 构造，主循环重试所有权在 QueryEngine。
    const client = getGrokClient({
      fetchOverride: options.fetchOverride as typeof fetch | undefined,
      source: options.querySource,
    })

    logForDebugging(
      `[Grok] Calling model=${grokModel}, messages=${openaiMessages.length}, tools=${openaiTools.length}`,
    )

    // Establishment-only connection retry (official Anthropic SDK
    // semantics): connection-class failures retry with capped backoff,
    // user aborts and server vetoes do not. A per-attempt watchdog guards
    // BOTH the establishment (first-byte window, same as the openai layer)
    // and the consumption loop — without it a stalled grok stream hung the
    // consuming generator forever (the pre-#31 leak family).
    //
    // Provider-concurrency slot (layer-2): acquired before the request goes
    // out and released when the adapted stream settles (releaseOnStreamEnd
    // finally — covers completion, error, break and teardown).
    // Establishment-retry notices (official g0 payloads) buffered during the
    // awaited retry loop, replayed into the message stream once the stream
    // is secured.
    const retryNotices: SystemAPIErrorMessage[] = []
    // W2.12 flush 面：establishment 终抛（budget 已尽 / RetryAfterTooLong /
    // user abort）时先回放缓冲的 "Retrying in Xs…" 行再让终错逃逸。
    let adaptedStream: AsyncGenerator<BetaRawMessageStreamEvent, void>
    // Replay-window teardown handles (see the TEARDOWN GUARD below). A
    // suspendedStart async generator's return() runs NO body finallys, so
    // when consumption never started the releaseOnStreamEnd chain cannot
    // unwind itself — the slot release and the per-attempt watchdog must be
    // captured here and torn down explicitly by the guard.
    let slotRelease: (() => void) | undefined
    let inFlightWatchdog:
      | import('../openai/streamWatchdog.js').StreamWatchdog
      | undefined
    try {
      adaptedStream = await withProviderSlot(
        'grok',
        async release => {
          slotRelease = release
          const { stream, watchdog } = await withConnectionRetry(
            async () => {
              const watchdog = createStreamWatchdog({
                url: `${(client.baseURL ?? 'https://api.x.ai/v1').replace(
                  /\/+$/,
                  '',
                )}/chat/completions`,
                model: grokModel,
                externalSignal: signal,
              })
              // Capture for the replay-window teardown guard (see below).
              inFlightWatchdog = watchdog
              try {
                const stream = await client.chat.completions.create(
                  {
                    model: grokModel,
                    messages: openaiMessages,
                    ...(openaiTools.length > 0 && {
                      tools: openaiTools,
                      ...(openaiToolChoice && {
                        tool_choice: openaiToolChoice,
                      }),
                    }),
                    stream: true,
                    stream_options: { include_usage: true },
                    ...(options.temperatureOverride !== undefined && {
                      temperature: options.temperatureOverride,
                    }),
                  } as ChatCompletionCreateParamsStreaming,
                  { signal: watchdog.signal },
                )
                watchdog.markEstablished()
                return { stream, watchdog }
              } catch (error) {
                watchdog.settle()
                throw error
              }
            },
            {
              signal,
              source: options.querySource,
              onRetryStatus: collectRetryStatus(retryNotices),
            },
          )

          return releaseOnStreamEnd(
            adaptOpenAIStreamToAnthropic(
              watchdog.wrap(stream) as AsyncIterable<ChatCompletionChunk>,
              grokModel,
            ),
            release,
          )
        },
        signal,
      )
    } catch (establishmentError) {
      for (const notice of retryNotices) yield notice
      retryNotices.length = 0
      throw establishmentError
    }

    const contentBlocks: Record<number, Record<string, unknown>> = {}
    const textDeltas = new Map<number, string[]>()
    const collectedMessages: AssistantMessage[] = []
    let partialMessage: BetaMessage | null = null
    let usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
    } = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let ttftMs = 0
    const start = Date.now()

    // The stream is secured — replay the buffered establishment-retry rows
    // (official g0 face) so the user sees the retry history in-stream.
    //
    // TEARDOWN GUARD (#31 residual orphan window, same shape as the OpenAI
    // layer): these yields suspend the generator AFTER `adaptedStream` exists
    // but BEFORE the for-await below takes over its teardown — for-await's
    // abrupt-completion protocol only closes the inner iterator for yields
    // INSIDE its body, so a consumer .return() at a replay yield would unwind
    // with NO enclosing finally reaching the stream: withProviderSlot's
    // release never fires (provider concurrency slot leaks),
    // watchdog.settle() never runs, the raw HTTP body hangs.
    //
    // Generator-return alone CANNOT be the fix: adaptedStream was never
    // iterated here (suspendedStart), and per generator semantics a return()
    // on a not-yet-started generator executes NO body finallys. The teardown
    // uses the captured handles (inFlightWatchdog/slotRelease): abort kills
    // the HTTP request through the watchdog controller and settles the
    // registry, slotRelease frees the concurrency slot — both idempotent, so
    // they compose with the normal releaseOnStreamEnd unwinding on the
    // started path (replayed=true skips the guard entirely).
    let replayed = false
    try {
      for (const notice of retryNotices) yield notice
      replayed = true
    } finally {
      if (!replayed) {
        inFlightWatchdog?.abort(
          new Error(
            'Grok stream abandoned before consumption (replay-window teardown)',
          ),
        )
        slotRelease?.()
        void adaptedStream?.return?.().catch(() => {})
      }
    }
    retryNotices.length = 0

    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start': {
          partialMessage = event.message
          ttftMs = Date.now() - start
          if (event.message.usage) {
            usage = updateOpenAIUsage(
              usage,
              event.message.usage as unknown as Parameters<
                typeof updateOpenAIUsage
              >[1],
            )
          }
          break
        }
        case 'content_block_start': {
          const idx = event.index
          const cb = event.content_block
          if (cb.type === 'tool_use') {
            contentBlocks[idx] = { ...cb, input: '' }
          } else if (cb.type === 'text') {
            contentBlocks[idx] = { ...cb, text: '' }
            textDeltas.set(idx, [])
          } else if (cb.type === 'thinking') {
            contentBlocks[idx] = { ...cb, thinking: '', signature: '' }
          } else {
            contentBlocks[idx] = { ...cb }
          }
          break
        }
        case 'content_block_delta': {
          const idx = event.index
          const delta = event.delta
          const block = contentBlocks[idx]
          if (!block) break
          if (delta.type === 'text_delta') {
            textDeltas.get(idx)?.push(delta.text)
          } else if (delta.type === 'input_json_delta') {
            block.input =
              ((block.input as string | undefined) || '') + delta.partial_json
          } else if (delta.type === 'thinking_delta') {
            block.thinking =
              ((block.thinking as string | undefined) || '') + delta.thinking
          } else if (delta.type === 'signature_delta') {
            block.signature = delta.signature
          }
          break
        }
        case 'content_block_stop': {
          const idx = event.index
          const block = contentBlocks[idx]
          if (!block || !partialMessage) break

          const deltas = textDeltas.get(idx)
          if (deltas) {
            if (block.type === 'text') {
              block.text = deltas.join('')
            }
            textDeltas.delete(idx)
          }

          const m: AssistantMessage = {
            message: {
              ...partialMessage,
              content: normalizeContentFromAPI(
                [block] as unknown as BetaMessage['content'],
                tools,
                options.agentId,
              ),
            } as AssistantMessage['message'],
            requestId: undefined,
            type: 'assistant',
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
          }
          collectedMessages.push(m)
          yield m
          break
        }
        case 'message_delta': {
          const deltaUsage = event.usage
          if (deltaUsage) {
            usage = updateOpenAIUsage(
              usage,
              deltaUsage as unknown as Parameters<typeof updateOpenAIUsage>[1],
            )
          }
          break
        }
        case 'message_stop':
          break
      }

      if (
        event.type === 'message_stop' &&
        usage.input_tokens + usage.output_tokens > 0
      ) {
        const costUSD = calculateUSDCost(
          grokModel,
          usage as unknown as BetaUsage,
        )
        addToTotalSessionCost(
          costUSD,
          usage as unknown as BetaUsage,
          options.model,
        )
      }

      yield {
        type: 'stream_event',
        event,
        ...(event.type === 'message_start' ? { ttftMs } : undefined),
      } as StreamEvent
    }

    // Record LLM observation in Langfuse (no-op if not configured)
    recordLLMObservation(options.langfuseTrace ?? null, {
      model: grokModel,
      provider: 'grok',
      input: convertMessagesToLangfuse(messagesForAPI, systemPrompt),
      output: convertOutputToLangfuse(collectedMessages),
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      },
      startTime: new Date(start),
      endTime: new Date(),
      completionStartTime: ttftMs > 0 ? new Date(start + ttftMs) : undefined,
      tools: convertToolsToLangfuse(toolSchemas as unknown[]),
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`[Grok] Error: ${errorMessage}`, { level: 'error' })
    yield createAssistantAPIErrorMessage({
      content: `API Error: ${errorMessage}`,
      apiError: 'api_error',
      error: (error instanceof Error
        ? error
        : new Error(String(error))) as unknown as SDKAssistantMessageError,
    })
  }
}
