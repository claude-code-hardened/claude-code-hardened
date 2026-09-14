import * as acp from '@agentclientprotocol/sdk'
import type { WSContext } from 'hono/ws'
import { cancelPendingPermissions } from './acp-client.js'
import { send, sendJsonRpcError } from './client-send.js'
import { resolveNewSessionPermissionMode } from './permission-mode.js'
import {
  clients,
  getAgentConfig,
  getDefaultPermissionMode,
  logAgent,
  logPrompt,
  logSession,
  logWs,
} from './runtime-state.js'
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  type ContentBlock,
  type SessionModelState,
} from './types.js'

/**
 * Derive the proxy's model-selector state from the agent's session config
 * options. SDK 1.x removed the unstable top-level `models` field from the
 * new/load/resume responses (schema 1.14+): the model list now rides on the
 * `category: 'model'` config option. The payload forwarded to proxy clients
 * keeps the legacy `models: { currentModelId, availableModels }` shape.
 */
function modelStateFromConfigOptions(
  configOptions: acp.SessionConfigOption[] | null | undefined,
): SessionModelState | null {
  if (!configOptions) return null
  const option = configOptions.find(
    o => o.category === 'model' || o.id === 'model',
  )
  if (!option || option.type !== 'select') return null
  if (typeof option.currentValue !== 'string') return null
  const availableModels: SessionModelState['availableModels'] = []
  for (const entry of option.options) {
    if ('value' in entry) {
      // SessionConfigSelectOption
      availableModels.push({
        modelId: entry.value,
        name: entry.name,
        ...(entry.description != null
          ? { description: entry.description }
          : {}),
      })
    } else {
      // SessionConfigSelectGroup — flatten its inner options.
      for (const inner of entry.options) {
        availableModels.push({
          modelId: inner.value,
          name: inner.name,
          ...(inner.description != null
            ? { description: inner.description }
            : {}),
        })
      }
    }
  }
  return { currentModelId: option.currentValue, availableModels }
}

export async function handleNewSession(
  ws: WSContext,
  params: { cwd?: string; permissionMode?: string },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection) {
    logAgent.warn(
      {
        hasState: !!state,
        hasProcess: !!state?.process,
        processKilled: state?.process?.killed,
        exitCode: state?.process?.exitCode,
      },
      'handleNewSession: not connected to agent',
    )
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'Not connected to agent',
    )
    return
  }

  const { cwd: AGENT_CWD } = getAgentConfig()

  try {
    const sessionCwd = params.cwd || AGENT_CWD
    let permissionMode: string | undefined
    try {
      permissionMode = resolveNewSessionPermissionMode(
        params.permissionMode,
        getDefaultPermissionMode(),
      )
    } catch (error) {
      sendJsonRpcError(
        ws,
        state,
        state.pendingJsonRpc?.id ?? null,
        JSONRPC_INVALID_PARAMS,
        (error as Error).message,
      )
      return
    }
    const result = await state.connection.newSession({
      cwd: sessionCwd,
      mcpServers: [],
      ...(permissionMode ? { _meta: { permissionMode } } : {}),
    })

    state.sessionId = result.sessionId
    state.modelState = modelStateFromConfigOptions(result.configOptions)
    logSession.info(
      {
        sessionId: result.sessionId,
        cwd: sessionCwd,
        hasModels: !!state.modelState,
      },
      'created',
    )

    send(ws, 'session_created', {
      ...result,
      promptCapabilities: state.promptCapabilities,
      models: state.modelState,
    })
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'create failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to create session: ${(error as Error).message}`,
    )
  }
}

// ============================================================================
// Session History Operations
// Reference: Zed's AgentConnection trait - list_sessions, load_session, resume_session
// ============================================================================

export async function handleListSessions(
  ws: WSContext,
  params: { cwd?: string; cursor?: string },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection) {
    logAgent.warn(
      {
        hasState: !!state,
        hasProcess: !!state?.process,
        processKilled: state?.process?.killed,
        exitCode: state?.process?.exitCode,
      },
      'handleListSessions: not connected to agent',
    )
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'Not connected to agent',
    )
    return
  }

  if (!state.agentCapabilities?.sessionCapabilities?.list) {
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_METHOD_NOT_FOUND,
      'Listing sessions is not supported by this agent',
    )
    return
  }

  try {
    const result = await state.connection.listSessions({
      cwd: params.cwd,
      cursor: params.cursor,
    })

    const MAX_SESSIONS = 20
    const sessions = result.sessions.slice(0, MAX_SESSIONS)
    logSession.info(
      {
        total: result.sessions.length,
        returned: sessions.length,
        hasMore: !!result.nextCursor,
      },
      'listed',
    )

    send(ws, 'session_list', {
      sessions: sessions.map((s: acp.SessionInfo) => ({
        _meta: s._meta,
        cwd: s.cwd,
        sessionId: s.sessionId,
        title: s.title,
        updatedAt: s.updatedAt,
      })),
      nextCursor: result.nextCursor,
      _meta: result._meta,
    })
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'list failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to list sessions: ${(error as Error).message}`,
    )
  }
}

export async function handleLoadSession(
  ws: WSContext,
  params: { sessionId: string; cwd?: string },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection) {
    logAgent.warn(
      {
        hasState: !!state,
        hasProcess: !!state?.process,
        processKilled: state?.process?.killed,
        exitCode: state?.process?.exitCode,
      },
      'handleLoadSession: not connected to agent',
    )
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'Not connected to agent',
    )
    return
  }

  if (!state.agentCapabilities?.loadSession) {
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_METHOD_NOT_FOUND,
      'Loading sessions is not supported by this agent',
    )
    return
  }

  const { cwd: AGENT_CWD } = getAgentConfig()

  try {
    const sessionCwd = params.cwd || AGENT_CWD
    const sessionId = params.sessionId
    const result = await state.connection.loadSession({
      sessionId,
      cwd: sessionCwd,
      mcpServers: [],
    })

    state.sessionId = sessionId
    state.modelState = modelStateFromConfigOptions(result.configOptions)
    logSession.info({ sessionId, cwd: sessionCwd }, 'loaded')

    send(ws, 'session_loaded', {
      sessionId,
      promptCapabilities: state.promptCapabilities,
      models: state.modelState,
    })
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'load failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to load session: ${(error as Error).message}`,
    )
  }
}

export async function handleResumeSession(
  ws: WSContext,
  params: { sessionId: string; cwd?: string },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection) {
    logAgent.warn(
      {
        hasState: !!state,
        hasProcess: !!state?.process,
        processKilled: state?.process?.killed,
        exitCode: state?.process?.exitCode,
      },
      'handleResumeSession: not connected to agent',
    )
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'Not connected to agent',
    )
    return
  }

  if (!state.agentCapabilities?.sessionCapabilities?.resume) {
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_METHOD_NOT_FOUND,
      'Resuming sessions is not supported by this agent',
    )
    return
  }

  const { cwd: AGENT_CWD } = getAgentConfig()

  try {
    const sessionCwd = params.cwd || AGENT_CWD
    const sessionId = params.sessionId
    const result = await state.connection.resumeSession({
      sessionId,
      cwd: sessionCwd,
    })

    state.sessionId = sessionId
    state.modelState = modelStateFromConfigOptions(result.configOptions)
    logSession.info({ sessionId, cwd: sessionCwd }, 'resumed')

    send(ws, 'session_resumed', {
      sessionId,
      promptCapabilities: state.promptCapabilities,
      models: state.modelState,
    })
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'resume failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to resume session: ${(error as Error).message}`,
    )
  }
}

// Reference: Zed's AcpThread.send() forwards Vec<acp::ContentBlock> to agent
export async function handlePrompt(
  ws: WSContext,
  params: { content: ContentBlock[] },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection || !state.sessionId) {
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'No active session',
    )
    return
  }

  try {
    const firstText = params.content.find(b => b.type === 'text')?.text
    const images = params.content.filter(b => b.type === 'image')
    logPrompt.debug(
      {
        text: firstText?.slice(0, 100),
        imageCount: images.length,
        blockCount: params.content.length,
      },
      'sending',
    )

    const result = await state.connection.prompt({
      sessionId: state.sessionId,
      prompt: params.content as acp.ContentBlock[],
    })

    logPrompt.info({ stopReason: result.stopReason }, 'completed')
    send(ws, 'prompt_complete', result)
  } catch (error) {
    logPrompt.error({ error: (error as Error).message }, 'failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Prompt failed: ${(error as Error).message}`,
    )
  }
}

// Handle cancel request from client
export async function handleCancel(ws: WSContext): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection || !state.sessionId) {
    logWs.warn('cancel requested but no active session')
    return
  }

  logSession.info({ sessionId: state.sessionId }, 'cancel requested')
  cancelPendingPermissions(state)

  try {
    await state.connection.cancel({ sessionId: state.sessionId })
    logSession.info({ sessionId: state.sessionId }, 'cancel sent')
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'cancel failed')
  }
}

// Reference: Zed's AgentModelSelector.select_model() calls connection.set_session_model()
export async function handleSetSessionModel(
  ws: WSContext,
  params: { modelId: string },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection || !state.sessionId) {
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'No active session',
    )
    return
  }

  if (!state.modelState) {
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_METHOD_NOT_FOUND,
      'Model selection not supported by this agent',
    )
    return
  }

  try {
    logSession.info(
      { sessionId: state.sessionId, modelId: params.modelId },
      'setting model',
    )
    // SDK 1.x removed `unstable_setSessionModel` along with the unstable
    // model-selector types (schema 1.14+): model switching goes through the
    // standard `session/set_config_option` method with the `model` config id.
    await state.connection.setSessionConfigOption({
      sessionId: state.sessionId,
      configId: 'model',
      value: params.modelId,
    })
    state.modelState = { ...state.modelState, currentModelId: params.modelId }
    send(ws, 'model_changed', { modelId: params.modelId })
    logSession.info({ modelId: params.modelId }, 'model changed')
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'set model failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to set model: ${(error as Error).message}`,
    )
  }
}
