import type {
  BetaToolUnion,
  BetaMessage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import { type Tools } from '../../../Tool.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js'
import type { SDKAssistantMessageError } from '../../../entrypoints/agentSdkTypes.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type { ThinkingConfig } from '../../../utils/thinking.js'
import type { Options } from '../claude.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../../services/langfuse/convert.js'
import {
  establishGeminiStream,
  getGeminiStreamUrl,
  projectGeminiStream,
} from './client.js'
import { withConnectionRetry } from 'src/services/api/connectionRetry.js'
import type { ConnectionRetryStatus } from 'src/services/api/connectionRetry.js'
import { retryStatusMessage } from 'src/services/api/connectionRetry.js'
import {
  releaseOnStreamEnd,
  withProviderSlot,
} from 'src/services/api/providerConcurrency.js'
import { createStreamWatchdog } from './streamWatchdog.js'
import {
  anthropicMessagesToGemini,
  resolveGeminiModel,
  adaptGeminiStreamToAnthropic,
  anthropicToolsToGemini,
  anthropicToolChoiceToGemini,
  GEMINI_THOUGHT_SIGNATURE_FIELD,
} from '@ant/model-provider'

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
    `[Gemini] Retrying-in ${Math.round(retryInMs / 100) / 10}s ` +
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

export async function* queryModelGemini(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
  thinkingConfig: ThinkingConfig,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  try {
    const geminiModel = resolveGeminiModel(options.model)
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
        const anyTool = t as unknown as Record<string, unknown>
        return (
          anyTool.type !== 'advisor_20260301' &&
          anyTool.type !== 'computer_20250124'
        )
      },
    )

    const { contents, systemInstruction } = anthropicMessagesToGemini(
      messagesForAPI,
      systemPrompt,
    )
    const geminiTools = anthropicToolsToGemini(standardTools)
    const toolChoice = anthropicToolChoiceToGemini(options.toolChoice)

    // Call Gemini API with streaming. Served by the official @google/genai
    // SDK (no hand-rolled fetch/SSE lives in this layer). Establishment runs
    // through withConnectionRetry (official SDK semantics: connection-class
    // failures retry with capped backoff; stream bodies are never retried).
    // Each attempt gets a fresh watchdog — a stall aborts through that
    // attempt's signal, so an idle-fired watchdog cannot poison the retry.
    // Stalled streams post-establishment are still guarded by the wrapped
    // watchdog from the successful attempt.
    //
    // Provider-concurrency slot (layer-2): acquired before the request goes
    // out, held until the settled stream is fully consumed
    // (releaseOnStreamEnd finally — closing it closes the adaptation chain
    // and the watchdog-wrapped stream, whose settle fires in the same
    // teardown).
    // Establishment-retry notices (official g0 payloads) buffered during the
    // awaited retry loop, replayed into the message stream once the stream
    // is secured.
    const retryNotices: SystemAPIErrorMessage[] = []
    const adaptedStream = await withProviderSlot(
      'gemini',
      async release => {
        const { stream } = await withConnectionRetry(
          async () => {
            const watchdog = createStreamWatchdog({
              url: getGeminiStreamUrl(geminiModel),
              model: geminiModel,
              externalSignal: signal,
            })
            try {
              const raw = await establishGeminiStream({
                model: geminiModel,
                signal: watchdog.signal,
                fetchOverride: options.fetchOverride as
                  | typeof fetch
                  | undefined,
                // Body layout mirrors the wire format (contents/systemInstruction/
                // tools/toolConfig/generationConfig) — the client maps it onto the
                // SDK's flattened GenerateContentConfig.
                body: {
                  contents,
                  ...(systemInstruction && { systemInstruction }),
                  ...(geminiTools.length > 0 && { tools: geminiTools }),
                  ...(toolChoice && {
                    toolConfig: {
                      functionCallingConfig: toolChoice,
                    },
                  }),
                  generationConfig: {
                    ...(options.temperatureOverride !== undefined && {
                      temperature: options.temperatureOverride,
                    }),
                    ...(thinkingConfig.type !== 'disabled' && {
                      thinkingConfig: {
                        includeThoughts: true,
                        ...(thinkingConfig.type === 'enabled' && {
                          thinkingBudget: thinkingConfig.budgetTokens,
                        }),
                      },
                    }),
                  },
                },
              })
              // Establishment succeeded — disarm the first-byte window before
              // the consumption loop re-arms the idle window.
              watchdog.markEstablished()
              return {
                stream: projectGeminiStream(watchdog.wrap(raw)),
                watchdog,
              }
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

        logForDebugging(
          `[Gemini] Calling model=${geminiModel}, messages=${contents.length}, tools=${geminiTools.length}`,
        )

        return releaseOnStreamEnd(
          adaptGeminiStreamToAnthropic(stream, geminiModel),
          release,
        )
      },
      signal,
    )

    const contentBlocks: Record<number, Record<string, unknown>> = {}
    const textDeltas = new Map<number, string[]>()
    const collectedMessages: AssistantMessage[] = []
    let partialMessage: BetaMessage | null = null
    let ttftMs = 0
    const start = Date.now()

    // The stream is secured — replay the buffered establishment-retry rows
    // (official g0 face) so the user sees the retry history in-stream.
    for (const notice of retryNotices) yield notice
    retryNotices.length = 0

    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start':
          partialMessage = event.message
          ttftMs = Date.now() - start
          break
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
            if (block.type === 'thinking') {
              block.signature = delta.signature
            } else {
              block[GEMINI_THOUGHT_SIGNATURE_FIELD] = delta.signature
            }
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

          const message: AssistantMessage = {
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
          collectedMessages.push(message)
          yield message
          break
        }
        case 'message_delta':
        case 'message_stop':
          break
      }

      yield {
        type: 'stream_event',
        event,
        ...(event.type === 'message_start' ? { ttftMs } : undefined),
      } as StreamEvent
    }

    // Record LLM observation in Langfuse (no-op if not configured)
    recordLLMObservation(options.langfuseTrace ?? null, {
      model: geminiModel,
      provider: 'gemini',
      input: convertMessagesToLangfuse(messagesForAPI, systemPrompt),
      output: convertOutputToLangfuse(collectedMessages),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      startTime: new Date(start),
      endTime: new Date(),
      completionStartTime: ttftMs > 0 ? new Date(start + ttftMs) : undefined,
      tools: convertToolsToLangfuse(toolSchemas as unknown[]),
      thinking:
        thinkingConfig.type !== 'disabled'
          ? {
              type: thinkingConfig.type,
              ...(thinkingConfig.type === 'enabled' && {
                budgetTokens: thinkingConfig.budgetTokens,
              }),
            }
          : undefined,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`[Gemini] Error: ${errorMessage}`, { level: 'error' })
    yield createAssistantAPIErrorMessage({
      content: `API Error: ${errorMessage}`,
      apiError: 'api_error',
      error: (error instanceof Error
        ? error
        : new Error(String(error))) as unknown as SDKAssistantMessageError,
    })
  }
}
