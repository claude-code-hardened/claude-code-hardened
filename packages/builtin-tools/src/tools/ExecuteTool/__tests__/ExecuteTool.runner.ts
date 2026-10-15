import { describe, test, expect } from 'bun:test'
import { mock } from 'bun:test'
import { z } from 'zod/v4'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

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
    test('deny from target checkPermissions is unchanged and does not consult canUseTool', async () => {
      const mockTarget = makeMockTool('SecretTool', 'secret')
      mockTarget.checkPermissions = async () =>
        ({
          behavior: 'deny' as const,
          message: 'Access denied',
        }) as never
      const ctx = makeContext([mockTarget])
      let gateCalls = 0
      const canUseTool = async () => {
        gateCalls++
        return { behavior: 'allow' } as never
      }

      const result = await ExecuteTool.call(
        { tool_name: 'SecretTool', params: {} },
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
      // Deny is decided by the target's own checkPermissions; the pipeline
      // gate is never reached.
      expect(gateCalls).toBe(0)
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
})
