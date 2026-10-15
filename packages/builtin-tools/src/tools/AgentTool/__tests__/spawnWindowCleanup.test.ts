/**
 * 3.8 item 3: spawn-window worktree guard in AgentTool.call.
 *
 * After createAgentWorktree succeeds, the registration steps that follow
 * (registerAsyncAgent on the async path, registerAgentForeground + the
 * runAgent iterator on the sync path) are throw-capable. Each is now guarded:
 * on failure the just-created worktree is removed via cleanupWorktreeIfNeeded
 * (same helper the completion/abort paths use) and the original error is
 * rethrown. These tests simulate registration failure after successful
 * worktree creation and assert the worktree is removed, not leaked.
 *
 * Written per repo mock rules (write-only in this batch): only the forced
 * side-effect chain + previously-registered UI/context stubs are mocked;
 * pure helpers load for real.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { errorsMock } from '../../../../../../tests/mocks/errors'
import {
  localAgentTaskMock,
  resetSpawnRegistrationFailure,
  spawnRegistrationFailure,
} from '../../../../../../tests/mocks/localAgentTask'
import { logMock } from '../../../../../../tests/mocks/log'
import {
  functionalStateMock,
} from '../../../../../../tests/mocks/state'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
// Functional state shim + shared errors/LocalAgentTask factories: Bun's
// mock.module is process-global, and this file previously registered a
// noop-setProjectRoot state mock and a 4-export errors.js mock that shrank
// the module for every later test file in the worker (agentToolUtils.test.ts
// needs 17 error exports) — part of why the whole AgentTool group went red
// (CI log /tmp/test1c.log:2771, 2790, 2812, 2831, 2850).
mock.module('src/bootstrap/state.js', functionalStateMock)
mock.module('src/bootstrap/state.ts', functionalStateMock)
mock.module('src/utils/errors.js', errorsMock)
mock.module('src/utils/errors.ts', errorsMock)
mock.module('src/tasks/LocalAgentTask/LocalAgentTask.js', localAgentTaskMock)

// Do not leak the registration-failure toggles into later test files.
afterAll(() => {
  resetSpawnRegistrationFailure()
})

const noop = () => {}

const createdWorktrees: string[] = []
const removedWorktrees: string[] = []

mock.module('src/utils/worktree.js', () => ({
  createAgentWorktree: async (slug: string) => {
    createdWorktrees.push(slug)
    return {
      worktreePath: join('/tmp', `wt-${slug}`),
      worktreeBranch: 'ccb-agent-x',
      headCommit: 'deadbeef',
      gitRoot: '/tmp',
      hookBased: false,
    }
  },
  hasWorktreeChanges: async () => false,
  removeAgentWorktree: async (p: string) => {
    removedWorktrees.push(p)
  },
}))

mock.module('src/utils/sessionStorage.js', () => ({
  writeAgentMetadata: async () => {},
}))

// Registration failure toggles come from the shared localAgentTask mock
// (tests/mocks/localAgentTask.ts) — set per test before calling AgentTool.call.

// Local runAgent is never reached in these failure scenarios, but its module
// must resolve (relative specifier resolved against this __tests__ dir).
mock.module('../runAgent.js', () => ({
  runAgent: () => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined }),
    }),
  }),
}))

mock.module('src/services/analytics/index.js', () => ({
  logEvent: noop,
  stripProtoFields: (v: any) => v,
  attachAnalyticsSink: noop,
}))
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
}))
mock.module('src/services/AgentSummary/agentSummary.js', () => ({
  startAgentSummarization: () => ({ stop: noop }),
}))
mock.module('src/services/api/dumpPrompts.js', () => ({
  clearDumpState: noop,
}))
// bootstrap/state is fully covered by the functional shim registered above —
// this partial 2-export mock used to overwrite it for the whole process.
mock.module('src/coordinator/coordinatorMode.js', () => ({
  isCoordinatorMode: () => false,
}))
mock.module('src/utils/promptCategory.js', () => ({
  getQuerySourceForAgent: () => 'agent_tool',
}))
mock.module('src/constants/prompts.js', () => ({
  getSystemPrompt: () => [],
  enhanceSystemPromptWithEnvDetails: (_getSys: any, prompt: any) => prompt,
}))
mock.module('src/Tool.js', () => ({
  // Identity so AgentTool.call is exercised directly (no def wrapper).
  buildTool: (def: any) => def,
  toolMatchesName: () => false,
  findToolByName: noop,
}))
mock.module('src/tools.js', () => ({ assembleToolPool: () => [] }))
mock.module('src/utils/agentToolFilter.js', () => ({
  filterParentToolsForFork: () => [],
}))
mock.module('src/types/ids.js', () => ({ asAgentId: (id: string) => id }))
mock.module('src/utils/agentContext.js', () => ({
  runWithAgentContext: (_ctx: any, fn: any) => fn(),
}))
mock.module('src/utils/agentSwarmsEnabled.js', () => ({
  isAgentSwarmsEnabled: () => false,
}))
mock.module('src/utils/cwd.js', () => ({
  getCwd: () => '/tmp',
  runWithCwdOverride: (_p: string, fn: any) => fn(),
}))
mock.module('src/utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
  isInProtectedNamespace: () => false,
}))
mock.module('src/utils/forkedAgent.js', () => ({}))
mock.module('src/utils/messages.ts', () => ({
  createUserMessage: (args: any) => ({ type: 'user', ...args }),
  extractTextContent: (content: any[]) =>
    content
      ?.filter?.((b: any) => b.type === 'text')
      ?.map?.((b: any) => b.text)
      ?.join('') ?? '',
  getLastAssistantMessage: () => null,
  isSyntheticMessage: () => false,
  normalizeMessages: (m: any[]) => m,
}))
mock.module('src/utils/model/agent.js', () => ({
  getAgentModel: () => undefined,
}))
mock.module('src/utils/permissions/PermissionMode.js', () => ({
  permissionModeSchema: { parse: (v: any) => v },
}))
mock.module('src/utils/permissions/permissions.js', () => ({
  // Pass-through: the shared paths under test need the discovered
  // general-purpose definition to survive the deny-rule filter.
  filterDeniedAgents: (agents: unknown[]) => agents,
  getDenyRuleForAgent: () => undefined,
}))
mock.module('src/utils/sdkEventQueue.js', () => ({
  enqueueSdkEvent: noop,
  emitTaskTerminatedSdk: noop,
}))
mock.module('src/utils/task/diskOutput.js', () => ({
  getTaskOutputPath: () => '/tmp/agent-out.jsonl',
}))
mock.module('src/utils/teammate.js', () => ({
  getParentSessionId: () => undefined,
  isTeammate: () => false,
}))
mock.module('src/utils/teammateContext.js', () => ({
  isInProcessTeammate: () => false,
}))
mock.module('src/utils/teleport.js', () => ({
  teleportToRemote: async () => undefined,
}))
mock.module('src/utils/tokens.js', () => ({
  getTokenCountFromUsage: () => 0,
  getAssistantMessageContentLength: () => 0,
}))
mock.module('src/utils/uuid.js', () => ({
  createAgentId: () => 'agentid-1234567890',
}))
mock.module('src/utils/systemPrompt.js', () => ({
  buildEffectiveSystemPrompt: () => '',
}))
mock.module('src/utils/systemPromptType.js', () => ({
  asSystemPrompt: (v: any) => v,
}))
mock.module('../BashTool/UI.js', () => ({ BackgroundHint: () => null }))
mock.module('../BashTool/toolName.js', () => ({ BASH_TOOL_NAME: 'bash' }))
mock.module('../FileReadTool/prompt.js', () => ({
  FILE_READ_TOOL_NAME: 'read',
}))
mock.module('../shared/spawnMultiAgent.js', () => ({
  spawnTeammate: async () => ({}),
}))
mock.module('./agentColorManager.js', () => ({ setAgentColor: noop }))
mock.module('./constants.js', () => ({
  AGENT_TOOL_NAME: 'agent',
  LEGACY_AGENT_TOOL_NAME: 'task',
}))
mock.module('./forkSubagent.js', () => ({ isForkSubagentEnabled: () => false }))
mock.module('./loadAgentsDir.js', () => ({
  filterAgentsByMcpRequirements: (a: any) => a,
  hasRequiredMcpServers: () => true,
  isBuiltInAgent: () => false,
}))
mock.module('./prompt.js', () => ({ getPrompt: () => '' }))
mock.module('./built-in/generalPurposeAgent.js', () => ({
  GENERAL_PURPOSE_AGENT: { agentType: 'general-purpose' },
}))

const { AgentTool } = await import('../AgentTool.js')

// call() requires canUseTool + parent assistant message; both guarded paths
// under test throw at registration before either stub is consumed.
const stubCanUseTool = async () => ({ behavior: 'allow' }) as any
const stubParentMessage = {
  type: 'assistant',
  message: { id: 'msg_parent', content: [] },
} as any

function makeContext(): any {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
      },
      mcp: { tools: [] },
      agentDefinitions: { activeAgents: [], customAgents: [] },
      tasks: {},
      agentNameRegistry: new Map(),
    }),
    setAppState: noop,
    abortController: new AbortController(),
    messages: [],
    // AgentTool.call resolves the spawn target through
    // toolUseContext.options.agentDefinitions.activeAgents
    // (AgentTool.tsx:477-478 — CI log /tmp/test1c.log:2763, 2782: the stub
    // previously only carried { tools: [] }, so call() crashed with
    // "undefined is not an object (evaluating
    // 'toolUseContext.options.agentDefinitions.activeAgents')" before either
    // registration path could fail).
    options: {
      tools: [],
      agentDefinitions: {
        activeAgents: [{ agentType: 'general-purpose' }],
        customAgents: [],
      },
    },
  }
}

describe('AgentTool spawn-window worktree guard', () => {
  test('async path: registerAsyncAgent failure removes the created worktree', async () => {
    spawnRegistrationFailure.sync = false
    spawnRegistrationFailure.async = true
    try {
      await AgentTool.call(
        // isolation: 'worktree' — the guard under test only exists once
        // createAgentWorktree has run (AgentTool.tsx:796-799); the stubbed
        // worktree module in this file records the create/remove pair.
        {
          prompt: 'do work',
          run_in_background: true,
          isolation: 'worktree',
        } as any,
        makeContext(),
        stubCanUseTool,
        stubParentMessage,
      )
      throw new Error('expected AgentTool.call to reject')
    } catch (error) {
      expect((error as Error).message).toBe('register-async-failed')
    }
    expect(createdWorktrees.length).toBe(1)
    expect(removedWorktrees.length).toBe(1)
  })

  test('sync path: foreground registration failure removes the worktree', async () => {
    spawnRegistrationFailure.async = false
    spawnRegistrationFailure.sync = true
    try {
      await AgentTool.call(
        { prompt: 'do work', isolation: 'worktree' } as any,
        makeContext(),
        stubCanUseTool,
        stubParentMessage,
      )
      throw new Error('expected AgentTool.call to reject')
    } catch (error) {
      expect((error as Error).message).toBe('register-foreground-failed')
    }
    expect(createdWorktrees.length).toBe(1)
    expect(removedWorktrees.length).toBe(1)
  })
})
