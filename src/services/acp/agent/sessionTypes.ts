import type {
  ClientCapabilities,
  SessionModeState,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'
import type { QueryEngine } from '../../../QueryEngine.js'
import type { Command } from '../../../types/command.js'
import type { AppState } from '../../../state/AppStateStore.js'
import type { ToolUseCache } from '../bridge.js'

// ── Model selection state ────────────────────────────────────────
//
// SDK 1.x removed the unstable model-selector types (`SessionModelState`,
// `SetSessionModelRequest`, schema 1.14+ "remove unstable model selectors"):
// models are now carried to clients as a `category: 'model'` session config
// option. We keep the same shape locally because the agent still needs to
// build and track that config option (current model + available options).

export type SessionModelOption = {
  modelId: string
  name: string
  description?: string
}

export type SessionModelState = {
  currentModelId: string
  availableModels: SessionModelOption[]
}

// ── Session state ─────────────────────────────────────────────────

export type AcpSession = {
  queryEngine: QueryEngine
  cancelled: boolean
  cancelGeneration: number
  cwd: string
  sessionFingerprint: string
  modes: SessionModeState
  models: SessionModelState
  configOptions: SessionConfigOption[]
  promptRunning: boolean
  pendingMessages: Map<string, PendingPrompt>
  pendingQueue: string[]
  pendingQueueHead: number
  toolUseCache: ToolUseCache
  clientCapabilities?: ClientCapabilities
  appState: AppState
  commands: Command[]
}

export type PendingPrompt = {
  resolve: (cancelled: boolean) => void
}
