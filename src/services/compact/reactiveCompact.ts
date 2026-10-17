import { isEnvTruthy } from '../../utils/envUtils.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import {
  isMediaSizeErrorMessage,
  isPromptTooLongMessage,
} from '../api/errors.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { type CompactionResult, compactConversation } from './compact.js'
import { logError } from '../../utils/log.js'
import { logForDebugging } from '../../utils/debug.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'

export const isReactiveOnlyMode: () => boolean = () => {
  // CCH wiring for the official reactive-only compaction path. Official
  // 2.1.284 ships telemetry counters reactive_compact_attempt/triggered/
  // failed/succeeded + a _remote variant (docs/reverse-284 decompiled/
  // 0001-chunk-* telemetry-events), but the decompiled source carries no
  // readable settings/gate key for the decision — wired up as settings/env
  // with default OFF, so the traditional /compact behavior (consumer:
  // src/commands/compact/compact.ts isReactiveOnlyMode gate) is unchanged.
  // Either of these enables:
  //   settings.json: { "compact": { "reactiveOnlyMode": true } }
  //   env:           ENABLE_REACTIVE_COMPACT_ONLY=1
  if (isEnvTruthy(process.env.ENABLE_REACTIVE_COMPACT_ONLY)) return true
  const settings = getSettings_DEPRECATED() as unknown as
    | { compact?: { reactiveOnlyMode?: boolean } }
    | null
  return settings?.compact?.reactiveOnlyMode === true
}

export const reactiveCompactOnPromptTooLong: (
  messages: Message[],
  cacheSafeParams: Record<string, unknown>,
  options: { customInstructions?: string; trigger?: string },
) => Promise<{ ok: boolean; reason?: string; result?: CompactionResult }> =
  async (messages, cacheSafeParams, options) => {
    const params = cacheSafeParams as unknown as CacheSafeParams
    try {
      const result = await compactConversation(
        messages,
        params.toolUseContext,
        params,
        true,
        options.customInstructions,
        true,
        {
          isRecompactionInChain: false,
          turnsSincePreviousCompact: 0,
          autoCompactThreshold: 0,
          querySource: 'compact',
        },
      )
      return { ok: true, result }
    } catch (error) {
      logError(error)
      return { ok: false, reason: String(error) }
    }
  }

export const isReactiveCompactEnabled: () => boolean = () => {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) return false
  return true
}

export const isWithheldPromptTooLong: (message: Message) => boolean =
  message => {
    if (message.type !== 'assistant' || !message.isApiErrorMessage) return false
    return isPromptTooLongMessage(message as AssistantMessage)
  }

export const isWithheldMediaSizeError: (message: Message) => boolean =
  message => {
    if (message.type !== 'assistant' || !message.isApiErrorMessage) return false
    return isMediaSizeErrorMessage(message as AssistantMessage)
  }

export const tryReactiveCompact: (params: {
  hasAttempted: boolean
  querySource: string
  aborted: boolean
  messages: Message[]
  cacheSafeParams: Record<string, unknown>
}) => Promise<CompactionResult | null> = async ({
  hasAttempted,
  aborted,
  messages,
  cacheSafeParams,
}) => {
  if (hasAttempted || aborted) return null
  const params = cacheSafeParams as unknown as CacheSafeParams
  try {
    const result = await compactConversation(
      messages,
      params.toolUseContext,
      params,
      true,
      undefined,
      true,
      {
        isRecompactionInChain: false,
        turnsSincePreviousCompact: 0,
        autoCompactThreshold: 0,
      },
    )
    return result
  } catch (error) {
    logForDebugging(
      `reactiveCompact: emergency compaction failed — ${String(error)}`,
      { level: 'warn' },
    )
    logError(error)
    return null
  }
}
