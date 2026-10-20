import { describe, test, expect } from 'bun:test'
import { mock } from 'bun:test'
import { z } from 'zod/v4'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
// ExecuteTool dynamically imports src/utils/hooks.js — register both
// specifier variants (process-global mock.module; both resolve to the same
// file but Bun matches on specifier where both exist).
mock.module('src/utils/debug.js', debugMock)

// Controllable hook replay fixture. Default state = "no hooks configured"
// (empty generators), so tests that don't care about hooks run unchanged.
type HookResultLike = {
  message?: unknown
  blockingError?: { blockingError: string }
  permissionBehavior?: 'allow' | 'deny' | 'ask'
  hookPermissionDecisionReason?: string
  updatedInput?: Record<string, unknown>
  additionalContexts?: string[]
}
const preToolHookCalls: Array<{
  toolName: string
  toolUseId: string
  toolInput: unknown
}> = []
const postToolHookCalls: Array<{
  toolName: string
  toolUseId: string
  toolInput: unknown
  toolResponse: unknown
}> = []
let hookFixture: { pre?: HookResultLike[]; post?: HookResultLike[] } = {}
const resetHookFixture = (): void => {
  hookFixture = {}
  preToolHookCalls.length = 0
  postToolHookCalls.length = 0
}

async function* emptyHookGenerator(): AsyncGenerator<HookResultLike> {}

// ESM link guard（与 tests/mocks/state.ts 的 withCompleteExportSurface 同款）：
// mock.module 进程级、last-write-wins、不可撤——本文件先注册的 hooks mock 若
// 缺面（如 executeWorktreeCreateHook），同进程后续加载的其他测试文件对
// src/utils/hooks 的具名导入在链接期报 "Export named '...' not found"。
// 快照真实模块的完整导出名（noop 兜底），仅 hook 重放三件套由 fixture 接管。
import * as realHooksModule from 'src/utils/hooks.js'
const realHooksSurface = realHooksModule as unknown as Record<string, unknown>

const hooksMock = () => {
  const fixtureDriven: Record<string, unknown> = {
    executePreToolHooks: async function* (
      toolName: string,
      toolUseId: string,
      toolInput: unknown,
    ): AsyncGenerator<HookResultLike> {
      preToolHookCalls.push({ toolName, toolUseId, toolInput })
      for (const result of hookFixture.pre ?? []) yield result
    },
    executePostToolHooks: async function* (
      toolName: string,
      toolUseId: string,
      toolInput: unknown,
      toolResponse: unknown,
    ): AsyncGenerator<HookResultLike> {
      postToolHookCalls.push({ toolName, toolUseId, toolInput, toolResponse })
      for (const result of hookFixture.post ?? []) yield result
    },
    getPreToolHookBlockingMessage: (
      hookName: string,
      error: { blockingError: string },
    ) => `${hookName} hook error: ${error.blockingError}`,
  }
  const baseline: Record<string, unknown> = {}
  const noop = (): void => {}
  for (const name of Object.keys(realHooksSurface)) {
    if (name in fixtureDriven) continue
    baseline[name] =
      typeof realHooksSurface[name] === 'function'
        ? noop // backstop for every non-fixture hook export
        : undefined
  }
  return { ...baseline, ...fixtureDriven }
}
void emptyHookGenerator
mock.module('src/utils/hooks.js', hooksMock)
mock.module('src/utils/hooks.ts', hooksMock)

// Attachments helper (dynamically imported by the PostToolUse replay) —
// hermetic stub: the real module drags the analytics chain into this
// otherwise-isolated runner subprocess.
const attachmentCalls: Array<Record<string, unknown>> = []
const attachmentsMock = () => ({
  createAttachmentMessage: (attachment: Record<string, unknown>) => {
    attachmentCalls.push(attachment)
    return { type: 'attachment', attachment, uuid: 'stub-attachment' }
  },
})
mock.module('src/utils/attachments.js', attachmentsMock)
mock.module('src/utils/attachments.ts', attachmentsMock)

// Mock all heavy dependencies before importing ExecuteTool
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getFeatureValue_DEPRECATED: async () => undefined,
  getFeatureValue_CACHED_WITH_REFRESH: async () => undefined,
  hasGrowthBookEnvOverride: () => false,
  getAllGrowthBookFeatures: () => ({}),
  getGrowthBookConfigOverrides: () => ({}),
  setGrowthBookConfigOverride: () => {},
  clearGrowthBookConfigOverrides: () => {},
  getApiBaseUrlHost: () => undefined,
  onGrowthBookRefresh: () => {},
  initializeGrowthBook: async () => {},
  checkSecurityRestrictionGate: async () => false,
  checkGate_CACHED_OR_BLOCKING: async () => false,
  refreshGrowthBookAfterAuthChange: () => {},
  resetGrowthBook: () => {},
  refreshGrowthBookFeatures: async () => {},
  setupPeriodicGrowthBookRefresh: () => {},
  stopPeriodicGrowthBookRefresh: () => {},
}))

mock.module('src/utils/searchExtraTools.js', () => ({
  isSearchExtraToolsEnabledOptimistic: () => true,
  getAutoSearchExtraToolsCharThreshold: () => 100,
  getSearchExtraToolsMode: () => 'tst' as const,
  isSearchExtraToolsToolAvailable: () => true,
  isSearchExtraToolsEnabled: async () => true,
  isToolReferenceBlock: () => false,
  // Mark every name as discovered so tests can exercise tools other than
  // TestTool/SecretTool without being blocked by the discovery guard.
  extractDiscoveredToolNames: () =>
    new Set([
      'TestTool',
      'SecretTool',
      'CronCreate',
      'WithDefaults',
      'McpTool',
      // Delegated-permission tests use these names.
      'WebFetchTool',
      'DeferredTool',
    ]),
  isDeferredToolsDeltaEnabled: () => false,
  getDeferredToolsDelta: () => null,
}))

mock.module('src/constants/tools.js', () => ({
  CORE_TOOLS: new Set(['ExecuteExtraTool', 'SearchExtraTools']),
}))

// Mock messages module
mock.module('src/utils/messages.js', () => ({
  createUserMessage: ({ content }: { content: string }) => ({
    type: 'user' as const,
    content,
    uuid: 'test-uuid',
  }),
  INTERRUPT_MESSAGE_FOR_TOOL_USE: '[Request interrupted]',
}))

const { ExecuteTool } = await import('../ExecuteTool.js')
const { EXECUTE_TOOL_NAME } = await import('../constants.js')

function makeContext(tools: unknown[] = []) {
  return {
    options: {
      tools,
    },
    cwd: '/tmp',
    sessionId: 'test',
  } as never
}

function makeMockTool(name: string, callResult: unknown = 'ok') {
  return {
    name,
    call: async () => ({ data: callResult }),
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    prompt: async () => `Description for ${name}`,
    description: async () => `Description for ${name}`,
    inputSchema: {},
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    isMcp: false,
    alwaysLoad: undefined,
    shouldDefer: undefined,
    searchHint: '',
    userFacingName: () => name,
    renderToolUseMessage: () => `Running ${name}`,
    mapToolResultToToolResultBlockParam: (content: unknown, id: string) => ({
      tool_use_id: id,
      type: 'tool_result',
      content,
    }),
  }
}

/**
 * Builds a mock tool with a real zod inputSchema, mirroring how actual
 * deferred tools (e.g. CronCreateTool) expose their schema. Records the
 * params that reach call() so tests can assert what was delegated.
 */
function makeMockToolWithSchema(
  name: string,
  schema: z.ZodType,
  opts: {
    validateInput?: (input: Record<string, unknown>) => {
      result: boolean
      message?: string
    }
  } = {},
) {
  const calls: Record<string, unknown>[] = []
  return {
    tool: {
      name,
      inputSchema: schema,
      call: async (input: Record<string, unknown>) => {
        calls.push(input)
        return { data: { ok: true, received: input } }
      },
      validateInput: opts.validateInput,
      checkPermissions: async () => ({ behavior: 'allow' as const }),
      isEnabled: () => true,
      isConcurrencySafe: () => true,
      isReadOnly: () => false,
      isMcp: false,
      userFacingName: () => name,
      renderToolUseMessage: () => `Running ${name}`,
      mapToolResultToToolResultBlockParam: (content: unknown, id: string) => ({
        tool_use_id: id,
        type: 'tool_result',
        content,
      }),
    },
    calls,
  }
}

describe('ExecuteTool', () => {
  test('executes a target tool by name', async () => {
    const mockTarget = makeMockTool('TestTool', { result: 'success' })
    const ctx = makeContext([mockTarget])

    const result = await ExecuteTool.call(
      { tool_name: 'TestTool', params: {} },
      ctx,
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    expect(result.data).toEqual({
      result: { result: 'success' },
      tool_name: 'TestTool',
    })
  })

  test('returns error when tool not found', async () => {
    const ctx = makeContext([])

    const result = await ExecuteTool.call(
      { tool_name: 'NonexistentTool', params: {} },
      ctx,
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    expect(result.data).toEqual({
      result: null,
      tool_name: 'NonexistentTool',
    })
    expect(result.newMessages).toBeDefined()
    expect(result.newMessages!.length).toBeGreaterThan(0)
  })

  test('returns permission denied when target denies', async () => {
    const mockTarget = makeMockTool('SecretTool', 'secret')
    mockTarget.checkPermissions = async () =>
      ({
        behavior: 'deny' as const,
        message: 'Access denied',
      }) as never
    const ctx = makeContext([mockTarget])

    const result = await ExecuteTool.call(
      { tool_name: 'SecretTool', params: {} },
      ctx,
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    expect(result.data).toEqual({
      result: null,
      tool_name: 'SecretTool',
    })
    expect(result.newMessages).toBeDefined()
  })

  test('returns error when deferred tool has not been discovered via SearchExtraTools', async () => {
    const mockTarget = makeMockTool('UndiscoveredTool', 'result')
    const ctx = makeContext([mockTarget])

    const result = await ExecuteTool.call(
      { tool_name: 'UndiscoveredTool', params: {} },
      ctx,
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    expect(result.data).toEqual({
      result: null,
      tool_name: 'UndiscoveredTool',
    })
    expect(result.newMessages).toBeDefined()
    expect(result.newMessages![0].content).toContain('has not been discovered')
  })

  test('has correct name', () => {
    expect(ExecuteTool.name).toBe(EXECUTE_TOOL_NAME)
  })

  test('searchHint contains keywords', () => {
    expect(ExecuteTool.searchHint).toContain('execute')
    expect(ExecuteTool.searchHint).toContain('tool')
  })

  test('schema-validates params against target tool before delegating', async () => {
    // Reproduces the CronCreate bug class: model passes 'schedule' but the
    // schema requires 'cron'. Without the pre-validation, params reach
    // validateInput with cron=undefined and crash on .trim().
    const { tool, calls } = makeMockToolWithSchema(
      'CronCreate',
      z.strictObject({
        cron: z.string(),
        prompt: z.string(),
      }),
      {
        validateInput: input => {
          // Mirrors CronCreateTool.validateInput pre-fix behavior — would
          // crash on undefined.trim() if schema pre-validation lets bad
          // params through. The guard in ExecuteTool must prevent this.
          const cron = input.cron as string | undefined
          if (typeof cron !== 'string') {
            throw new TypeError(
              "undefined is not an object (evaluating 'cron.trim')",
            )
          }
          return { result: true }
        },
      },
    )
    const ctx = makeContext([tool])

    const result = await ExecuteTool.call(
      {
        tool_name: 'CronCreate',
        params: { schedule: '*/5 * * * *', prompt: 'hi' },
      },
      ctx,
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    // Schema validation rejects the wrong field name and returns a model-
    // friendly error instead of crashing.
    expect(result.data).toEqual({
      result: null,
      tool_name: 'CronCreate',
    })
    expect(result.newMessages).toBeDefined()
    const message = result.newMessages![0].content as string
    // Model gets told both what was missing and what was unexpected.
    expect(message).toMatch(/cron/i)
    expect(message).toMatch(/schedule/i)
    // validateInput was never called, so no crash reached it.
    expect(calls.length).toBe(0)
  })

  test('passes through parsed params to target tool, applying schema defaults', async () => {
    const { tool, calls } = makeMockToolWithSchema(
      'WithDefaults',
      z.strictObject({
        cron: z.string(),
        prompt: z.string(),
        recurring: z.boolean().default(true),
      }),
    )
    const ctx = makeContext([tool])

    const result = await ExecuteTool.call(
      {
        // recurring intentionally omitted — schema default must fill it in.
        tool_name: 'WithDefaults',
        params: { cron: '*/5 * * * *', prompt: 'hi' },
      },
      ctx,
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    expect(result.data).toEqual({
      result: {
        ok: true,
        received: { cron: '*/5 * * * *', prompt: 'hi', recurring: true },
      },
      tool_name: 'WithDefaults',
    })
    expect(calls.length).toBe(1)
    // .default() applied — target tool sees recurring: true without
    // needing to defend against undefined itself.
    expect(calls[0]).toEqual({
      cron: '*/5 * * * *',
      prompt: 'hi',
      recurring: true,
    })
  })

  test('skips schema validation for tools without safeParse (e.g. MCP)', async () => {
    // MCP tools expose inputJSONSchema, not zod — must not crash on
    // duck-typed schema check.
    const mockTarget = makeMockTool('McpTool', { result: 'ok' })
    const ctx = makeContext([mockTarget])

    const result = await ExecuteTool.call(
      { tool_name: 'McpTool', params: { anything: true } },
      ctx,
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    expect(result.data).toEqual({
      result: { result: 'ok' },
      tool_name: 'McpTool',
    })
  })

  describe('delegated permission enforcement', () => {
    test('deny from target checkPermissions rides through canUseTool (forceDecision) and still denies', async () => {
      // QueryEngine-wrapped-canUseTool simulation: any non-allow result that
      // the gate produces is recorded as an SDK permission_denial entry.
      const mockTarget = makeMockTool('SecretTool', 'secret')
      mockTarget.checkPermissions = async () =>
        ({
          behavior: 'deny' as const,
          message: 'Access denied',
        }) as never
      const ctx = makeContext([mockTarget])
      const denials: Array<{
        tool: string
        input: unknown
        forceDecision: unknown
      }> = []
      const canUseTool = async (
        tool: { name: string },
        _input: Record<string, unknown>,
        _toolUseContext: unknown,
        _assistantMessage: unknown,
        _toolUseId: string,
        forceDecision?: { behavior: string },
      ) => {
        const decision = (forceDecision ?? {
          behavior: 'allow',
        }) as { behavior: string; message?: string }
        if (decision.behavior !== 'allow') {
          denials.push({
            tool: tool.name,
            input: _input,
            forceDecision,
          })
        }
        return decision as never
      }

      const result = await ExecuteTool.call(
        { tool_name: 'SecretTool', params: { k: 'v' } },
        ctx,
        canUseTool,
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      expect(result.data).toEqual({
        result: null,
        tool_name: 'SecretTool',
      })
      expect(result.newMessages![0].content).toContain('Access denied')
      // Denial now flows through the canUseTool decision layer — the wrapped
      // gate saw the deny and the SDK report captures it (was short-circuited
      // before canUseTool; the rejection never reached permission_denials).
      expect(denials.length).toBe(1)
      expect(denials[0].tool).toBe('SecretTool')
      expect(denials[0].forceDecision).toMatchObject({
        behavior: 'deny',
        message: 'Access denied',
      })
      // Target never executed.
      expect(postToolHookCalls.length).toBe(0)
    })

    test('ask + user rejects -> delegation returns denial without executing target', async () => {
      const mockTarget = makeMockTool('WebFetchTool', 'fetched')
      mockTarget.checkPermissions = async () =>
        ({
          behavior: 'ask' as const,
          message: 'WebFetch requires approval for this domain',
        }) as never
      let targetCalls = 0
      mockTarget.call = async () => {
        targetCalls++
        return { data: 'fetched' }
      }
      const ctx = makeContext([mockTarget])
      const gateCalls: Array<{ tool: string; input: unknown }> = []
      const canUseTool = async (
        tool: { name: string },
        input: Record<string, unknown>,
      ) => {
        gateCalls.push({ tool: tool.name, input })
        return {
          behavior: 'deny',
          message: 'User rejected WebFetch',
        } as never
      }

      const result = await ExecuteTool.call(
        {
          tool_name: 'WebFetchTool',
          params: { url: 'https://example.com' },
        },
        ctx,
        canUseTool,
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      expect(result.data).toEqual({
        result: null,
        tool_name: 'WebFetchTool',
      })
      const message = result.newMessages![0].content as string
      expect(message).toContain('Permission denied for tool "WebFetchTool"')
      expect(message).toContain('User rejected WebFetch')
      // The full pipeline (canUseTool) was consulted with the delegated
      // params — this is the bypass regression test: pre-fix, an 'ask'
      // target result skipped the gate entirely.
      expect(gateCalls.length).toBe(1)
      expect(gateCalls[0].tool).toBe('WebFetchTool')
      expect(gateCalls[0].input).toEqual({ url: 'https://example.com' })
      // Target tool never executed.
      expect(targetCalls).toBe(0)
    })

    test('ask + user allows -> delegation executes and keeps success shape', async () => {
      const mockTarget = makeMockTool('WebFetchTool', { page: 'content' })
      mockTarget.checkPermissions = async () =>
        ({
          behavior: 'ask' as const,
          message: 'WebFetch requires approval for this domain',
        }) as never
      const ctx = makeContext([mockTarget])
      const canUseTool = async () => ({ behavior: 'allow' as const })

      const result = await ExecuteTool.call(
        { tool_name: 'WebFetchTool', params: {} },
        ctx,
        canUseTool,
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      // Successful delegation shape is unchanged: result wrapped with
      // tool_name, no denial message appended.
      expect(result.data).toEqual({
        result: { page: 'content' },
        tool_name: 'WebFetchTool',
      })
      expect(result.newMessages).toBeUndefined()
    })

    test('passthrough from target checkPermissions is routed through canUseTool', async () => {
      const mockTarget = makeMockTool('DeferredTool', { ok: 1 })
      mockTarget.checkPermissions = async () =>
        ({ behavior: 'passthrough' as const, message: '' }) as never
      let targetCalls = 0
      mockTarget.call = async () => {
        targetCalls++
        return { data: { ok: 1 } }
      }
      const ctx = makeContext([mockTarget])
      let gateCalls = 0
      const canUseTool = async () => {
        gateCalls++
        return { behavior: 'allow' as const }
      }

      const result = await ExecuteTool.call(
        { tool_name: 'DeferredTool', params: {} },
        ctx,
        canUseTool,
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      // The gate decided — passthrough alone must not authorize a delegated
      // call constructed from model-provided params.
      expect(gateCalls).toBe(1)
      expect(targetCalls).toBe(1)
      expect(result.data).toEqual({
        result: { ok: 1 },
        tool_name: 'DeferredTool',
      })
    })

    test('applies updatedInput from the permission pipeline before delegating', async () => {
      const { tool, calls } = makeMockToolWithSchema(
        'WithDefaults',
        z.strictObject({
          cron: z.string(),
          prompt: z.string(),
        }),
      )
      tool.checkPermissions = async () =>
        ({ behavior: 'ask' as const, message: 'needs approval' }) as never
      const ctx = makeContext([tool])
      const canUseTool = async () =>
        ({
          behavior: 'allow' as const,
          updatedInput: { cron: '0 0 * * *', prompt: 'hi' },
        }) as never

      const result = await ExecuteTool.call(
        {
          tool_name: 'WithDefaults',
          params: { cron: '0 0 * * *', prompt: 'hi' },
        },
        ctx,
        canUseTool,
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      // Parity with the standard pipeline: target receives the pipeline's
      // rewritten input.
      expect(calls[0]).toEqual({ cron: '0 0 * * *', prompt: 'hi' })
      expect(result.data.tool_name).toBe('WithDefaults')
    })

    test('no canUseTool available -> fail closed with denial', async () => {
      const mockTarget = makeMockTool('WebFetchTool', 'fetched')
      mockTarget.checkPermissions = async () =>
        ({ behavior: 'ask' as const, message: 'needs approval' }) as never
      let targetCalls = 0
      mockTarget.call = async () => {
        targetCalls++
        return { data: 'fetched' }
      }
      const ctx = makeContext([mockTarget])

      const result = await ExecuteTool.call(
        { tool_name: 'WebFetchTool', params: {} },
        ctx,
        undefined as never,
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      expect(result.data).toEqual({
        result: null,
        tool_name: 'WebFetchTool',
      })
      expect(targetCalls).toBe(0)
    })
  })

  describe('target-name hook replay', () => {
    // Hook replay only reaches executePreToolHooks/executePostToolHooks when
    // the context carries app state (hasHookForEvent reads from it).
    function makeContextWithAppState(tools: unknown[]): never {
      return {
        options: { tools },
        cwd: '/tmp',
        sessionId: 'test',
        toolUseId: 'hooktest-1',
        getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
        abortController: new AbortController(),
      } as never
    }

    test('PreToolUse runs under the TARGET tool name with decomposed params', async () => {
      const mockTarget = makeMockTool('WebFetchTool', { page: 'x' })
      const ctx = makeContextWithAppState([mockTarget])
      resetHookFixture()

      await ExecuteTool.call(
        {
          tool_name: 'WebFetchTool',
          params: { url: 'https://example.com' },
        },
        ctx,
        async () => ({ behavior: 'allow' as const }),
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      expect(preToolHookCalls.length).toBe(1)
      // The hook line sees the real tool name, NOT "ExecuteExtraTool".
      expect(preToolHookCalls[0].toolName).toBe('WebFetchTool')
      expect(preToolHookCalls[0].toolInput).toEqual({
        url: 'https://example.com',
      })
      expect(preToolHookCalls[0].toolUseId).toBe('hooktest-1')
      // PostToolUse was also re-bound to the target name with the response.
      expect(postToolHookCalls.length).toBe(1)
      expect(postToolHookCalls[0].toolName).toBe('WebFetchTool')
      expect(postToolHookCalls[0].toolResponse).toEqual({ page: 'x' })
    })

    test('PreToolUse deny for the target name stops the delegation with the hook reason', async () => {
      const mockTarget = makeMockTool('McpTool', { ran: true })
      let targetCalls = 0
      mockTarget.call = async () => {
        targetCalls++
        return { data: { ran: true } }
      }
      mockTarget.checkPermissions = async () => ({ behavior: 'allow' }) as never
      const ctx = makeContextWithAppState([mockTarget])
      resetHookFixture()
      hookFixture.pre = [
        {
          permissionBehavior: 'deny',
          hookPermissionDecisionReason:
            'PreToolUse:McpTool blocked compound rm -rf',
        },
      ]

      const result = await ExecuteTool.call(
        {
          tool_name: 'McpTool',
          params: { command: 'rm -rf /tmp/x' },
        },
        ctx,
        async () => ({ behavior: 'allow' as const }),
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      expect(result.data).toEqual({
        result: null,
        tool_name: 'McpTool',
      })
      const message = result.newMessages![0].content as string
      expect(message).toContain('PreToolUse:McpTool blocked compound rm -rf')
      // deny 停止执行：目标从未运行，PostToolUse 不补投。
      expect(targetCalls).toBe(0)
      expect(postToolHookCalls.length).toBe(0)
    })

    test('PreToolUse blockingError denies with the standard hook error text', async () => {
      const mockTarget = makeMockTool('WebFetchTool', { ran: true })
      const ctx = makeContextWithAppState([mockTarget])
      resetHookFixture()
      hookFixture.pre = [
        { blockingError: { blockingError: 'non-zero exit code 2' } },
      ]

      const result = await ExecuteTool.call(
        { tool_name: 'WebFetchTool', params: { command: 'echo hi' } },
        ctx,
        async () => ({ behavior: 'allow' as const }),
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      expect(result.data.result).toBe(null)
      expect(result.newMessages![0].content).toContain(
        'PreToolUse:WebFetchTool hook error: non-zero exit code 2',
      )
    })

    test('PreToolUse ask for the target name rides to canUseTool as forceDecision', async () => {
      const mockTarget = makeMockTool('WebFetchTool', { page: 'x' })
      const ctx = makeContextWithAppState([mockTarget])
      resetHookFixture()
      hookFixture.pre = [
        {
          permissionBehavior: 'ask',
          hookPermissionDecisionReason: 'Hook asks about this domain',
        },
      ]
      let forceDecision: unknown
      const canUseTool = async (
        _tool: unknown,
        _input: unknown,
        _ctx: unknown,
        _assistantMessage: unknown,
        _toolUseId: string,
        fd?: unknown,
      ) => {
        forceDecision = fd
        return { behavior: 'allow' as const }
      }

      const result = await ExecuteTool.call(
        {
          tool_name: 'WebFetchTool',
          params: { url: 'https://example.com' },
        },
        ctx,
        canUseTool,
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      // Hook ask → the gate is consulted (dialog surface sees the hook's
      // message) — allow from the gate proceeds to execute.
      expect(forceDecision).toMatchObject({
        behavior: 'ask',
        message: 'Hook asks about this domain',
      })
      expect(result.data.result).toEqual({ page: 'x' })
    })

    test('PostToolUse blocking error and additional context come back as newMessages for the target name', async () => {
      const mockTarget = makeMockTool('McpTool', { ran: true })
      const ctx = makeContextWithAppState([mockTarget])
      resetHookFixture()
      hookFixture.post = [
        {
          blockingError: { blockingError: 'guarded path touched' },
          additionalContexts: ['hook says: double-check the diff'],
        },
      ]

      const result = await ExecuteTool.call(
        { tool_name: 'McpTool', params: { command: 'echo hi' } },
        ctx,
        async () => ({ behavior: 'allow' as const }),
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      expect(result.data.result).toEqual({ ran: true })
      const messages = result.newMessages ?? []
      // blocking error surfaces as a model-visible message…
      expect(
        messages.some(m =>
          String((m as { content?: unknown }).content).includes(
            'PostToolUse:McpTool hook error: guarded path touched',
          ),
        ),
      ).toBe(true)
      // …and the additional context rides as a hook attachment for the
      // TARGET name (pipeline-shaped hook_additional_context attachment).
      expect(attachmentCalls.length).toBe(1)
      expect(attachmentCalls[0]).toMatchObject({
        type: 'hook_additional_context',
        hookName: 'PostToolUse:McpTool',
        content: ['hook says: double-check the diff'],
      })
    })

    test('no app state in context -> hook replay is skipped, delegation still gated', async () => {
      const mockTarget = makeMockTool('McpTool', { ran: true })
      const ctx = makeContext([mockTarget]) // no getAppState
      resetHookFixture()

      const result = await ExecuteTool.call(
        { tool_name: 'McpTool', params: {} },
        ctx,
        async () => ({ behavior: 'allow' as const }),
        { type: 'assistant', content: [], uuid: 'msg1' } as never,
        undefined,
      )

      expect(preToolHookCalls.length).toBe(0)
      expect(postToolHookCalls.length).toBe(0)
      expect(result.data.result).toEqual({ ran: true })
    })
  })
})
