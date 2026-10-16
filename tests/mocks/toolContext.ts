/**
 * Shared minimal ToolUseContext stub for tool unit tests.
 *
 * Provides only the fields tools actually access in tests:
 *  - getAppState() returns a context with empty rule arrays for every source
 *  - toolUseId / parentMessageId / assistantMessageId / turnId can be
 *    overridden per test for budget tracking tests
 *
 * Usage:
 *   import { mockToolContext } from 'tests/mocks/toolContext'
 *   const ctx = mockToolContext({ toolUseId: 't1' })
 *
 * Per memory feedback "Mock dependency not subject" — this exists so each
 * tool test file does not redefine the same partial stub.
 */

const emptyRules = {
  user: [],
  project: [],
  local: [],
  session: [],
  cliArg: [],
}

export interface MockToolContextOptions {
  toolUseId?: string
  parentMessageId?: string
  assistantMessageId?: string
  turnId?: string
  /** Override toolPermissionContext fields (e.g. mode, alwaysAllowRules). */
  permissionOverrides?: Record<string, unknown>
  /** 注入既有 controller（默认新建一个活动 controller——spawn signal 面用）。 */
  abortController?: AbortController
}

export function mockToolContext(opts: MockToolContextOptions = {}): never {
  return {
    toolUseId: opts.toolUseId,
    parentMessageId: opts.parentMessageId,
    assistantMessageId: opts.assistantMessageId,
    turnId: opts.turnId,
    // GrepTool 等 call() 解构 context.abortController.signal——缺失即同步
    // TypeError（rg 分支第一行 spawn 选项）。默认新建活动 controller。
    abortController: opts.abortController ?? new AbortController(),
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Set(),
        alwaysAllowRules: { ...emptyRules },
        alwaysDenyRules: { ...emptyRules },
        alwaysAskRules: { ...emptyRules },
        isBypassPermissionsModeAvailable: false,
        ...(opts.permissionOverrides ?? {}),
      },
    }),
  } as never
}
