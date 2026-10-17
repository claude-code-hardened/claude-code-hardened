// Auto-generated stub — replace with real implementation
// CCH: CONTEXT_COLLAPSE is a deliberate half-implemented stub. Message-level
// collapse storage (see persists/entries that official drains and re-commits)
// was never implemented, so enabling the feature would suppress auto compact
// and strand the context window. see docs/reverse-284 + scripts/defines.ts.
// Safety: while FEATURE_CONTEXT_COLLAPSE is on, every public entry point throws
// instead of silently no-op'ing, so the flag can never be "accidentally on".
import { feature } from 'bun:bundle'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { QuerySource } from '../../constants/querySource.js'

export interface ContextCollapseHealth {
  totalSpawns: number
  totalErrors: number
  lastError: string | null
  emptySpawnWarningEmitted: boolean
  totalEmptySpawns: number
}

export interface ContextCollapseStats {
  collapsedSpans: number
  collapsedMessages: number
  stagedSpans: number
  health: ContextCollapseHealth
}

export interface CollapseResult {
  messages: Message[]
}

export interface DrainResult {
  committed: number
  messages: Message[]
}

export const getStats: () => ContextCollapseStats = () => ({
  collapsedSpans: 0,
  collapsedMessages: 0,
  stagedSpans: 0,
  health: {
    totalSpawns: 0,
    totalErrors: 0,
    lastError: null,
    emptySpawnWarningEmitted: false,
    totalEmptySpawns: 0,
  },
})

let _contextCollapseEnabled = false

export function isContextCollapseEnabled(): boolean {
  return _contextCollapseEnabled
}

export const subscribe: (callback: () => void) => () => void =
  (_callback: () => void) => () => {}

/**
 * Guard for un-implemented CONTEXT_COLLAPSE entry points. Storage is not
 * implemented in CCH (defines.ts keeps the feature disabled for exactly this
 * reason), so a force-enabled gate must fail loudly instead of silently
 * dropping auto compact / collapsing behavior.
 */
export function assertContextCollapseNotEnabled(): void {
  if (feature('CONTEXT_COLLAPSE')) {
    throw new Error(
      'CONTEXT_COLLAPSE is not implemented in this build: message collapse storage ' +
        '(persist/drain/commit) is absent, so enabling the feature would suppress auto ' +
        'compact and strand the context window. Remove FEATURE_CONTEXT_COLLAPSE=1 ' +
        '(see scripts/defines.ts) or implement the storage layer first.',
    )
  }
}

export const applyCollapsesIfNeeded: (
  messages: Message[],
  toolUseContext: ToolUseContext,
  querySource: QuerySource,
) => Promise<CollapseResult> = async (messages: Message[]) => {
  assertContextCollapseNotEnabled()
  return { messages }
}

export const isWithheldPromptTooLong: (
  message: Message,
  isPromptTooLongMessage: (msg: Message) => boolean,
  querySource: QuerySource,
) => boolean = () => false

export const recoverFromOverflow: (
  messages: Message[],
  querySource: QuerySource,
) => DrainResult = (messages: Message[]) => ({ committed: 0, messages })

export function resetContextCollapse(): void {
  _contextCollapseEnabled = false
}

export function initContextCollapse(): void {
  _contextCollapseEnabled = true
}
