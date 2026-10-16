import { mock, describe, expect, test } from 'bun:test'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { errorsMock } from '../../../../../../tests/mocks/errors'

// ─── Mocks for agentToolUtils.ts dependencies ───
// Only mock modules that are truly unavailable or cause side effects.
// Do NOT mock common/shared modules (zod/v4, bootstrap/state, etc.) to avoid
// corrupting the module cache for other test files in the same Bun process.

const noop = () => {}

mock.module('bun:bundle', () => ({ feature: () => false }))

mock.module('src/constants/tools.js', () => ({
  ALL_AGENT_DISALLOWED_TOOLS: new Set(),
  ASYNC_AGENT_ALLOWED_TOOLS: new Set(),
  CUSTOM_AGENT_DISALLOWED_TOOLS: new Set(),
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS: new Set(),
}))

mock.module('src/services/AgentSummary/agentSummary.js', () => ({
  startAgentSummarization: noop,
}))

mock.module('src/services/analytics/index.js', () => ({
  logEvent: noop,
  logEventAsync: async () => {},
  stripProtoFields: (v: any) => v,
  attachAnalyticsSink: noop,
  _resetForTesting: noop,
  AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: undefined,
}))

mock.module('src/services/api/dumpPrompts.js', () => ({
  clearDumpState: noop,
}))

mock.module('src/Tool.js', () => ({
  toolMatchesName: () => false,
  findToolByName: noop,
}))

// messages.ts is complex - provide stubs for all named exports
mock.module('src/utils/messages.ts', () => ({
  extractTextContent: (content: any[]) =>
    content
      ?.filter?.((b: any) => b.type === 'text')
      ?.map?.((b: any) => b.text)
      ?.join('') ?? '',
  getLastAssistantMessage: (messages: any[]) =>
    [...(messages ?? [])].reverse().find((m: any) => m?.type === 'assistant') ??
    null,
  SYNTHETIC_MESSAGES: new Set(),
  INTERRUPT_MESSAGE: '',
  INTERRUPT_MESSAGE_FOR_TOOL_USE: '',
  CANCEL_MESSAGE: '',
  REJECT_MESSAGE: '',
  REJECT_MESSAGE_WITH_REASON_PREFIX: '',
  SUBAGENT_REJECT_MESSAGE: '',
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX: '',
  PLAN_REJECTION_PREFIX: '',
  DENIAL_WORKAROUND_GUIDANCE: '',
  NO_RESPONSE_REQUESTED: '',
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER: '',
  SYNTHETIC_MODEL: '',
  AUTO_REJECT_MESSAGE: noop,
  DONT_ASK_REJECT_MESSAGE: noop,
  withMemoryCorrectionHint: (s: string) => s,
  deriveShortMessageId: () => '',
  isClassifierDenial: () => false,
  buildYoloRejectionMessage: () => '',
  buildClassifierUnavailableMessage: () => '',
  isEmptyMessageText: () => true,
  createAssistantMessage: noop,
  createAssistantAPIErrorMessage: noop,
  createUserMessage: noop,
  prepareUserContent: noop,
  createUserInterruptionMessage: noop,
  createSyntheticUserCaveatMessage: noop,
  formatCommandInputTags: noop,
}))

// Quit teardown (3.8): spy recording for teardownRunningAgentsOnQuit tests.
// Shared factory (tests/mocks/localAgentTask.ts) so both AgentTool test files
// register an identical module shape — previously each file registered a
// disjoint mock for the same process-global module (Bun mock.module is
// last-write-wins) and the group went red in CI
// (CI log /tmp/test1c.log:2771, 2790, 2812, 2831, 2850).
const { getKillAsyncAgentCalls, localAgentTaskMock, resetKillAsyncAgentCalls } =
  await import('../../../../../../tests/mocks/localAgentTask')

mock.module('src/tasks/LocalAgentTask/LocalAgentTask.js', localAgentTaskMock)

// UI/context chain pulled in by src/hooks/useCancelRequest.ts
// (only loaded for teardownRunningAgentsOnQuit coverage)
mock.module('src/keybindings/useKeybinding.js', () => ({ useKeybinding: noop }))
mock.module('src/keybindings/shortcutFormat.js', () => ({
  getShortcutDisplay: () => '',
}))
mock.module('src/hooks/useCommandQueue.js', () => ({
  useCommandQueue: () => [],
}))
mock.module('src/context/notifications.js', () => ({
  useNotifications: () => ({ addNotification: noop, removeNotification: noop }),
}))
mock.module('src/context/overlayContext.js', () => ({
  useIsOverlayActive: () => false,
}))
mock.module('src/components/PromptInput/utils.js', () => ({
  isVimModeEnabled: () => false,
}))
mock.module('src/state/teammateViewHelpers.js', () => ({
  exitTeammateView: noop,
}))
mock.module('src/utils/messageQueueManager.js', () => ({
  clearCommandQueue: noop,
  enqueuePendingNotification: noop,
  hasCommandsInQueue: () => false,
}))
mock.module('src/utils/sdkEventQueue.js', () => ({
  emitTaskTerminatedSdk: noop,
  enqueueSdkEvent: noop,
}))

mock.module('src/utils/debug.ts', debugMock)

// Shared 17-export factory — identical to spawnWindowCleanup.test.ts's
// registration so the process-global mock shape is order-independent.
mock.module('src/utils/errors.js', errorsMock)
mock.module('src/utils/errors.ts', errorsMock)

mock.module('src/utils/forkedAgent.js', () => ({}))

mock.module('src/utils/permissions/yoloClassifier.js', () => ({
  buildTranscriptForClassifier: () => '',
  classifyYoloAction: () => null,
}))

mock.module('src/utils/task/sdkProgress.js', () => ({
  emitTaskProgress: noop,
}))

mock.module('src/utils/tokens.js', () => ({
  getTokenCountFromUsage: () => 0,
}))

mock.module('src/tools/ExitPlanModeTool/constants.js', () => ({
  EXIT_PLAN_MODE_V2_TOOL_NAME: 'exit_plan_mode',
}))

mock.module('src/tools/AgentTool/constants.js', () => ({
  AGENT_TOOL_NAME: 'agent',
  LEGACY_AGENT_TOOL_NAME: 'task',
}))

mock.module('src/tools/AgentTool/loadAgentsDir.js', () => ({}))

mock.module('src/state/AppState.js', () => ({
  useAppState: () => undefined,
  useAppStateStore: () => ({ getState: () => ({ tasks: {} }) }),
  useSetAppState: () => noop,
}))

mock.module('src/types/ids.js', () => ({
  asAgentId: (id: string) => id,
}))

// Break circular dep
mock.module('src/tools/AgentTool/AgentTool.tsx', () => ({
  AgentTool: {},
  inputSchema: {},
  outputSchema: {},
  default: {},
}))

const {
  countToolUses,
  getLastToolUseName,
  BoundedAgentMessageBuffer,
  appendCappedAgentMessage,
  finalizeAgentToolUnpatched: finalizeAgentTool,
  MAX_AGENT_MESSAGES_IN_MEMORY,
} = await import('../agentToolUtils')

// teardownRunningAgentsOnQuit lives in useCancelRequest (quit-path owner),
// not agentToolUtils — its UI/context dep chain is mocked above.
const { teardownRunningAgentsOnQuit } = await import(
  'src/hooks/useCancelRequest.js'
)

function makeAssistantMessage(content: any[]): any {
  return { type: 'assistant', message: { content } }
}

function makeUserMessage(text: string): any {
  return { type: 'user', message: { content: text } }
}

describe('countToolUses', () => {
  test('counts tool_use blocks in messages', () => {
    const messages = [
      makeAssistantMessage([
        { type: 'tool_use', name: 'Read' },
        { type: 'text', text: 'hello' },
      ]),
    ]
    expect(countToolUses(messages)).toBe(1)
  })

  test('returns 0 for messages without tool_use', () => {
    const messages = [makeAssistantMessage([{ type: 'text', text: 'hello' }])]
    expect(countToolUses(messages)).toBe(0)
  })

  test('returns 0 for empty array', () => {
    expect(countToolUses([])).toBe(0)
  })

  test('counts multiple tool_use blocks across messages', () => {
    const messages = [
      makeAssistantMessage([{ type: 'tool_use', name: 'Read' }]),
      makeUserMessage('ok'),
      makeAssistantMessage([{ type: 'tool_use', name: 'Write' }]),
    ]
    expect(countToolUses(messages)).toBe(2)
  })

  test('counts tool_use in single message with multiple blocks', () => {
    const messages = [
      makeAssistantMessage([
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Grep' },
        { type: 'tool_use', name: 'Write' },
      ]),
    ]
    expect(countToolUses(messages)).toBe(3)
  })
})

describe('getLastToolUseName', () => {
  test('returns last tool name from assistant message', () => {
    const msg = makeAssistantMessage([
      { type: 'tool_use', name: 'Read' },
      { type: 'tool_use', name: 'Write' },
    ])
    expect(getLastToolUseName(msg)).toBe('Write')
  })

  test('returns undefined for message without tool_use', () => {
    const msg = makeAssistantMessage([{ type: 'text', text: 'hello' }])
    expect(getLastToolUseName(msg)).toBeUndefined()
  })

  test('returns the last tool when multiple tool_uses present', () => {
    const msg = makeAssistantMessage([
      { type: 'tool_use', name: 'Read' },
      { type: 'tool_use', name: 'Grep' },
      { type: 'tool_use', name: 'Edit' },
    ])
    expect(getLastToolUseName(msg)).toBe('Edit')
  })

  test('returns undefined for non-assistant message', () => {
    const msg = makeUserMessage('hello')
    expect(getLastToolUseName(msg)).toBeUndefined()
  })

  test('handles message with null content', () => {
    const msg = { type: 'assistant', message: { content: null } } as any
    expect(getLastToolUseName(msg)).toBeUndefined()
  })
})

// ─── 3.8 item 1: bounded in-memory transcript (ring capacity) ───

function makeSeqMessage(i: number, isAssistant: boolean): any {
  return isAssistant
    ? {
        type: 'assistant',
        message: {
          id: `m_${i}`,
          content: [{ type: 'tool_use', name: 'Bash', i }],
          usage: {},
        },
        uuid: `u_${i}`,
      }
    : { type: 'user', message: { content: 'hi' }, uuid: `u_${i}` }
}

describe('BoundedAgentMessageBuffer', () => {
  test('caps the tail at MAX_AGENT_MESSAGES_IN_MEMORY, keeping newest', () => {
    const buffer = new BoundedAgentMessageBuffer()
    const total = MAX_AGENT_MESSAGES_IN_MEMORY + 50
    for (let i = 0; i < total; i++) {
      buffer.push(makeSeqMessage(i, i % 2 === 0))
    }
    const tail = buffer.asArray()
    expect(MAX_AGENT_MESSAGES_IN_MEMORY).toBe(200)
    expect(tail.length).toBe(MAX_AGENT_MESSAGES_IN_MEMORY)
    // Oldest 50 evicted — first retained is index 50, newest kept verbatim.
    expect(String(tail[0]!.uuid)).toBe('u_50')
    expect(String(tail[tail.length - 1]!.uuid)).toBe('u_249')
  })

  test('tracks whole-stream counts across evicted head entries', () => {
    const buffer = new BoundedAgentMessageBuffer()
    const total = MAX_AGENT_MESSAGES_IN_MEMORY + 50
    for (let i = 0; i < total; i++) {
      buffer.push(makeSeqMessage(i, i % 2 === 0))
    }
    // 125 assistant messages streamed, each carrying exactly one tool_use.
    expect(buffer.totalMessages).toBe(total)
    expect(buffer.totalToolUses).toBe(125)
  })

  test('behaves like a plain array below the cap', () => {
    const buffer = new BoundedAgentMessageBuffer()
    buffer.push(makeSeqMessage(0, false))
    buffer.push(makeSeqMessage(1, true))
    expect(buffer.asArray().length).toBe(2)
    expect(buffer.totalMessages).toBe(2)
    expect(buffer.totalToolUses).toBe(1)
  })
})

describe('appendCappedAgentMessage', () => {
  test('truncates from the head when the cap is exceeded', () => {
    const base: any[] = []
    for (let i = 0; i < MAX_AGENT_MESSAGES_IN_MEMORY; i++) {
      base.push(makeSeqMessage(i, false))
    }
    const next = appendCappedAgentMessage(base, makeSeqMessage(999, false))
    expect(next.length).toBe(MAX_AGENT_MESSAGES_IN_MEMORY)
    expect(String(next[0]!.uuid)).toBe('u_1')
    expect(String(next[next.length - 1]!.uuid)).toBe('u_999')
  })

  test('appends under the cap and tolerates missing base', () => {
    const next = appendCappedAgentMessage(undefined, makeSeqMessage(0, false))
    expect(next.length).toBe(1)
  })
})

describe('finalizeAgentTool streamStats', () => {
  const metadata = {
    prompt: 'do work',
    resolvedAgentModel: 'test-model',
    isBuiltInAgent: true,
    startTime: Date.now() - 100,
    agentType: 'general',
    isAsync: true,
  }

  test('uses whole-stream overrides instead of truncated-array math', () => {
    // Tail holds 1 assistant/1 tool_use, but the stream had 7/23.
    const tail = [makeSeqMessage(0, true)]
    const result = finalizeAgentTool(tail, 'agent-1', metadata, {
      totalMessageCount: 23,
      totalToolUseCount: 7,
    })
    expect(result.totalToolUseCount).toBe(7)
  })

  test('without overrides falls back to in-place counting', () => {
    const tail = [
      makeSeqMessage(0, true),
      makeSeqMessage(1, true),
      makeSeqMessage(2, false),
    ]
    const result = finalizeAgentTool(tail, 'agent-2', metadata)
    expect(result.totalToolUseCount).toBe(2)
  })
})

// ─── 3.8 item 2: user-quit teardown (killAllRunningAgentTasks hook) ───

describe('teardownRunningAgentsOnQuit', () => {
  test('kills only running local_agent tasks and reports the count', () => {
    resetKillAsyncAgentCalls()
    const setAppStateCalls: number[] = []
    const tasks = {
      a: { type: 'local_agent', status: 'running' },
      b: { type: 'local_agent', status: 'completed' },
      c: { type: 'local_shell', status: 'running' },
      d: { type: 'local_agent', status: 'running' },
    } as any
    const killed = teardownRunningAgentsOnQuit(tasks, () => {
      setAppStateCalls.push(1)
    })
    expect(killed).toBe(2)
    expect([...getKillAsyncAgentCalls()].sort()).toEqual(['a', 'd'])
    // Real killAsyncAgent runs one setAppState update per killed task
    // (LocalAgentTask.tsx:338-360 → updateTaskState); the shared mock mirrors
    // that (CI log /tmp/test1c.log:2850 — setAppStateCalls Expected 2,
    // Received 0 with the old spy-only mock).
    expect(setAppStateCalls.length).toBe(2)
  })

  test('is a no-op when nothing is running (natural-end safety)', () => {
    resetKillAsyncAgentCalls()
    const tasks = {
      a: { type: 'local_agent', status: 'completed' },
      b: { type: 'local_shell', status: 'running' },
    } as any
    let setAppStateCalled = false
    const killed = teardownRunningAgentsOnQuit(tasks, () => {
      setAppStateCalled = true
    })
    expect(killed).toBe(0)
    expect(getKillAsyncAgentCalls().length).toBe(0)
    expect(setAppStateCalled).toBe(false)
  })
})
