import { z } from 'zod/v4'
import {
  buildTool,
  findToolByName,
  type Tool,
  type ToolDef,
  type ToolUseContext,
  type ToolResult,
  type Tools,
} from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { createUserMessage } from 'src/utils/messages.js'
import { formatZodValidationError } from 'src/utils/toolErrors.js'
import {
  extractDiscoveredToolNames,
  isSearchExtraToolsEnabledOptimistic,
  isSearchExtraToolsToolAvailable,
} from 'src/utils/searchExtraTools.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { EXECUTE_TOOL_NAME } from './constants.js'
import { isDeferredTool } from '../SearchExtraToolsTool/prompt.js'

/**
 * 官方对照（reverse-284 _ALL.js:10321，ToolSearch select 引导文案）：
 * `. Call ${Ge.name} instead, loading it first with ${Ha} query
 * "select:${Ge.name}" if it is not loaded yet.` / `. Call ${Ge.name} instead.`
 * 官方没有委派包装 —— select 之后模型直呼目标工具名，PreToolUse /
 * PostToolUse / canUseTool 天然命中真名。CCH 保留委派形态（ExecuteExtraTool），
 * 因此必须在委派执行前后以【目标工具名 + 分解后的输入】重放钩子，线位的
 * 防线才与官方"直呼工具名"等价。已知形态差异（报告口径）：官方路径下钩子
 * 进度消息/blockedError 由主管道流式产出；委派路径在 tool.call 内部，进度
 * 无法回流，改为把 blocking/additionalContext 插为 NewMessages（附件消息），
 * 决策面（deny/ask/updatedInput）语义保持一致且 allow 从不越权（钩子 allow
 * 不跳过 canUseTool——反向防线：本路径 always-consult-gate）。
 */

type PreToolUseReplay =
  | {
      behavior: 'deny' | 'ask'
      message: string
      updatedInput?: Record<string, unknown>
    }
  | { behavior: 'passthrough'; updatedInput?: Record<string, unknown> }

/**
 * Replay PreToolUse hooks under the TARGET tool's own name with the
 * decomposed input, mirroring the main pipeline's runPreToolUseHooks
 * aggregation (deny > ask > allow; hook blockingError ⇒ deny). Returns null
 * when no hooks produced a decision or input mutation. Hook 'allow'
 * deliberately does NOT bypass the canUseTool gate here (the delegation path
 * always consults the gate — matches this tool's pre-existing always-gate
 * contract), while deny/ask are enforced exactly like the pipeline.
 *
 * Dynamic import: src/utils/hooks.ts drags the settings/analytics chains;
 * loading it lazily keeps ExecuteTool import-time cheap and avoids any
 * module-init cycles with src/tools.ts. No app state / hook infra failures
 * are logged and treated as "no hooks" (a context without getAppState has no
 * hook surface to run).
 */
async function replayPreToolUseHooks(
  targetTool: Tool,
  params: Record<string, unknown>,
  context: ToolUseContext,
  toolUseID: string,
): Promise<PreToolUseReplay | null> {
  let appState: unknown
  try {
    appState = context.getAppState?.()
  } catch {
    // Minimal contexts (subagents/SDK without app state) carry no hook
    // surface — nothing to replay.
    return null
  }
  if (appState == null) return null

  try {
    const hooks = await import('src/utils/hooks.js')
    const permissionMode = (
      appState as { toolPermissionContext?: { mode?: string } }
    ).toolPermissionContext?.mode
    let decision: PreToolUseReplay | null = null
    let mutatedInput: Record<string, unknown> | undefined
    for await (const result of hooks.executePreToolHooks(
      targetTool.name,
      toolUseID,
      params,
      context,
      permissionMode,
      context.abortController?.signal,
      undefined,
      context.requestPrompt,
      targetTool.getToolUseSummary?.(params),
    )) {
      if (result.blockingError) {
        return {
          behavior: 'deny',
          message: hooks.getPreToolHookBlockingMessage(
            `PreToolUse:${targetTool.name}`,
            result.blockingError,
          ),
        }
      }
      if (result.permissionBehavior === 'deny') {
        decision = {
          behavior: 'deny',
          message:
            result.hookPermissionDecisionReason ||
            `Hook PreToolUse:${targetTool.name} denied this tool call`,
        }
      } else if (result.permissionBehavior === 'ask' && decision === null) {
        decision = {
          behavior: 'ask',
          message:
            result.hookPermissionDecisionReason ||
            `Hook PreToolUse:${targetTool.name} requires approval`,
          updatedInput:
            (result.updatedInput as Record<string, unknown> | undefined) ??
            params,
        }
      }
      // Passthrough mutator: adopt the hook's rewritten input (pipeline
      // parity — updatedInput without a permission decision flows to the
      // gate and the tool call).
      if (
        result.updatedInput &&
        result.permissionBehavior === undefined &&
        typeof result.updatedInput === 'object'
      ) {
        mutatedInput = result.updatedInput as Record<string, unknown>
      }
    }
    if (decision !== null) {
      if (decision.updatedInput === undefined && mutatedInput) {
        decision.updatedInput = mutatedInput
      }
      return decision
    }
    if (mutatedInput) {
      return { behavior: 'passthrough', updatedInput: mutatedInput }
    }
    return null
  } catch (error) {
    // Hook infrastructure failure — mirror runPreToolUseHooks' outer catch
    // (log, no crash); the gate + target validation still apply.
    import('src/utils/debug.js').then(({ logForDebugging }) =>
      logForDebugging(
        `ExecuteExtraTool PreToolUse replay failed for ${targetTool.name}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    return null
  }
}

/**
 * Fire PostToolUse hooks under the TARGET tool's name after a successful
 * delegation (official fires them for the real tool name; CCH's pipeline can
 * only see "ExecuteExtraTool"). Hook outputs that would have been yielded as
 * stream messages (blocking errors, additional context) come back as
 * newMessages attachments so the model still receives them.
 */
async function replayPostToolUseHooks(
  targetTool: Tool,
  params: Record<string, unknown>,
  toolResponse: unknown,
  context: ToolUseContext,
  toolUseID: string,
): Promise<
  ReturnType<typeof import('src/utils/messages.js').createUserMessage>[]
> {
  let appState: unknown
  try {
    appState = context.getAppState?.()
  } catch {
    return []
  }
  if (appState == null) return []

  const extraMessages: ReturnType<
    typeof import('src/utils/messages.js').createUserMessage
  >[] = []
  try {
    const [
      { executePostToolHooks },
      { createAttachmentMessage },
      { createUserMessage },
    ] = await Promise.all([
      import('src/utils/hooks.js'),
      import('src/utils/attachments.js'),
      import('src/utils/messages.js'),
    ])
    const permissionMode = (
      appState as { toolPermissionContext?: { mode?: string } }
    ).toolPermissionContext?.mode
    for await (const result of executePostToolHooks(
      targetTool.name,
      toolUseID,
      params,
      toolResponse,
      context,
      permissionMode,
      context.abortController?.signal,
    )) {
      if (result.blockingError) {
        extraMessages.push(
          createUserMessage({
            content: `PostToolUse:${targetTool.name} hook error: ${result.blockingError.blockingError}`,
          }),
        )
      }
      if (result.additionalContexts && result.additionalContexts.length > 0) {
        extraMessages.push(
          createAttachmentMessage({
            type: 'hook_additional_context',
            content: result.additionalContexts,
            hookName: `PostToolUse:${targetTool.name}`,
            toolUseID,
            hookEvent: 'PostToolUse',
          }) as never,
        )
      }
    }
  } catch (error) {
    import('src/utils/debug.js').then(({ logForDebugging }) =>
      logForDebugging(
        `ExecuteExtraTool PostToolUse replay failed for ${targetTool.name}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }
  return extraMessages
}

export const inputSchema = lazySchema(() =>
  z.object({
    tool_name: z
      .string()
      .describe(
        'The exact name of the target tool to execute (e.g., "CronCreate", "mcp__server__action")',
      ),
    params: z
      .record(z.string(), z.unknown())
      .describe('The parameters to pass to the target tool'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    result: z.unknown(),
    tool_name: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * Rejection result for a delegated tool call, shaped identically to the
 * target tool's own deny branch: `result: null` plus a user message carrying
 * the denial reason back to the model.
 */
function deniedDelegation(
  toolName: string,
  reason: string,
): ToolResult<Output> {
  return {
    data: {
      result: null,
      tool_name: toolName,
    },
    newMessages: [
      createUserMessage({
        content: `Permission denied for tool "${toolName}": ${reason}`,
      }),
    ],
  }
}

export const ExecuteTool = buildTool({
  name: EXECUTE_TOOL_NAME,
  searchHint: 'execute run invoke call a deferred tool by name with parameters',
  maxResultSizeChars: 100_000,
  isConcurrencySafe() {
    return false
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  async call(input, context, canUseTool, parentMessage, onProgress) {
    const tools: Tools = context.options.tools ?? []

    const targetTool = findToolByName(tools, input.tool_name)
    if (!targetTool) {
      return {
        data: {
          result: null,
          tool_name: input.tool_name,
        },
        newMessages: [
          createUserMessage({
            content: `Tool "${input.tool_name}" not found. Use SearchExtraTools to discover available tools.`,
          }),
        ],
      }
    }

    // Guard: block execution of undiscovered deferred tools.
    // When tool search is active, deferred tools must be discovered via
    // SearchExtraTools first so the model has seen their schemas and knows
    // the correct parameters.  Executing an undiscovered tool almost always
    // fails with parameter validation errors.
    if (
      isSearchExtraToolsEnabledOptimistic() &&
      isSearchExtraToolsToolAvailable(tools) &&
      isDeferredTool(targetTool)
    ) {
      const discovered = extractDiscoveredToolNames(context.messages)
      if (!discovered.has(input.tool_name)) {
        return {
          data: {
            result: null,
            tool_name: input.tool_name,
          },
          newMessages: [
            createUserMessage({
              content: `Tool "${input.tool_name}" has not been discovered yet. You must first use SearchExtraTools to discover this tool before executing it.\n\nUsage: SearchExtraTools("select:${input.tool_name}")`,
            }),
          ],
        }
      }
    }

    // Check if the target tool is currently enabled
    if (!targetTool.isEnabled()) {
      return {
        data: {
          result: null,
          tool_name: input.tool_name,
        },
        newMessages: [
          createUserMessage({
            content: `工具 "${input.tool_name}" 当前不可用：Remote Control 未连接。`,
          }),
        ],
      }
    }

    // Schema-validate params against the target tool BEFORE delegating.
    // ExecuteExtraTool passes raw params straight from the model to
    // validateInput/call without re-running the target's zod schema, so a
    // wrong field name (e.g. 'schedule' instead of 'cron') or a missing
    // required field reaches the tool as undefined and the first
    // .trim()/.length/.split() crashes with "undefined is not an object".
    // CronCreateTool's .trim() crash was the reported symptom; centralizing
    // the check here covers every deferred tool without relying on each one
    // to defensively guard its own validateInput. Duck-typed so MCP tools
    // (whose schema is inputJSONSchema, not zod) skip this branch.
    const targetSchema = targetTool.inputSchema as
      | { safeParse?: (data: unknown) => unknown }
      | undefined
    if (targetSchema?.safeParse) {
      const parsed = targetSchema.safeParse(input.params) as
        | { success: true; data: Record<string, unknown> }
        | { success: false; error: z.ZodError }
      if (!parsed.success) {
        return {
          data: {
            result: null,
            tool_name: input.tool_name,
          },
          newMessages: [
            createUserMessage({
              content: formatZodValidationError(input.tool_name, parsed.error),
            }),
          ],
        }
      }
      // Use parsed params going forward — picks up .default() values and
      // strips unknown keys for strictObject schemas so validateInput/call
      // never see fields they don't expect.
      input.params = parsed.data
    }

    // Validate input before delegating — prevents crashes when the model
    // omits required params (e.g. TeamCreate without team_name →
    // sanitizeName(undefined).replace() TypeError).
    if (targetTool.validateInput) {
      const validation = await targetTool.validateInput(
        input.params as Record<string, unknown>,
        context,
      )
      if (!validation.result) {
        return {
          data: {
            result: null,
            tool_name: input.tool_name,
          },
          newMessages: [
            createUserMessage({
              content: `Invalid parameters for tool "${input.tool_name}": ${validation.message}`,
            }),
          ],
        }
      }
    }

    // Replay PreToolUse hooks under the TARGET tool's own name with the
    // decomposed input (official has no delegation wrapper — after ToolSearch
    // select the model calls the tool directly, `_ALL.js:10321` "Call
    // ${Ge.name} instead" — so CCH must re-bind the hook line to the real
    // name here or `PreToolUse:Bash|WebFetch` defenses silently miss the
    // delegated path).
    const toolUseId = context.toolUseId ?? ''
    const hookReplay = await replayPreToolUseHooks(
      targetTool,
      input.params as Record<string, unknown>,
      context,
      toolUseId,
    )
    if (hookReplay?.behavior === 'deny') {
      return deniedDelegation(input.tool_name, hookReplay.message)
    }
    if (hookReplay?.behavior === 'passthrough' && hookReplay.updatedInput) {
      input.params = hookReplay.updatedInput
    }

    // Target-tool permission surface — folded INTO the canUseTool decision
    // layer instead of short-circuiting: a deny travels through canUseTool as
    // `forceDecision`, so QueryEngine's wrapped canUseTool records it in the
    // permission_denials SDK report (previously this deny returned before
    // canUseTool ran and the rejection went unreported). Deny enforcement is
    // also applied below even when a custom canUseTool ignores forceDecision.
    const targetPermResult = await targetTool.checkPermissions?.(
      input.params as Record<string, unknown>,
      context,
    )
    const targetPermDeny =
      targetPermResult && targetPermResult.behavior === 'deny'
        ? targetPermResult
        : undefined

    // Authorization gate for the delegation path. A delegated call must
    // NEVER execute on the strength of the target tool's checkPermissions
    // alone: the pipeline's canUseTool also applies session-level deny/ask
    // rules, permission mode (e.g. don'tAsk → deny, bypass → allow),
    // defaults, and PermissionRequest hooks. Previously any
    // 'ask'/'passthrough' result skipped the prompt entirely, so tools like
    // WebFetch lost their `domain:` rule enforcement when invoked through
    // ExecuteExtraTool (audit-confirmed authorization bypass).
    //
    // canUseTool resolves 'ask' interactively (REPL dialog / headless
    // permission prompt tool) and always returns allow or deny, so this is
    // safe to call on every execution path — including subagents and SDK
    // consumers, which thread their own canUseTool down here.
    if (!canUseTool) {
      // No permission interface available: nothing can authorize a
      // non-deny target. Fail closed rather than executing unapproved.
      return deniedDelegation(input.tool_name, 'Permission denied')
    }
    // forceDecision precedence: a PreToolUse:Target 'ask' rides along as the
    // pipeline's hook-ask does (dialog shows the hook's message); a target
    // checkPermissions deny is pre-decided (no point showing an interactive
    // prompt for a decision already made).
    const forceDecision =
      targetPermDeny ??
      (hookReplay?.behavior === 'ask'
        ? {
            behavior: 'ask' as const,
            message: hookReplay.message,
            ...(hookReplay.updatedInput !== undefined
              ? { updatedInput: hookReplay.updatedInput }
              : {}),
          }
        : undefined)
    const decision = await canUseTool(
      targetTool,
      input.params as Record<string, unknown>,
      context,
      parentMessage,
      toolUseId,
      forceDecision,
    )
    if (decision.behavior !== 'allow') {
      // 'deny' from rules/mode/hooks, or an unresolved 'ask' (fail-closed —
      // full canUseTool implementations resolve ask before returning).
      return deniedDelegation(
        input.tool_name,
        decision.message || 'Permission denied',
      )
    }
    if (targetPermDeny) {
      // Custom canUseTool implementations may ignore forceDecision; the
      // target tool's own deny must still stop the delegation.
      return deniedDelegation(
        input.tool_name,
        targetPermDeny.message ?? 'Permission denied',
      )
    }

    // The permission pipeline may rewrite the input (updatedInput) — the
    // standard toolExecution path applies it the same way before tool.call.
    if (decision.updatedInput !== undefined) {
      input.params = decision.updatedInput
    }

    // Delegate execution to the target tool
    const targetResult: ToolResult<unknown> = await targetTool.call(
      input.params as Record<string, unknown>,
      context,
      canUseTool,
      parentMessage,
      onProgress,
    )

    // PostToolUse 补投：以目标工具名（而非 ExecuteExtraTool）重放，hook
    // blocking/additionalContext 以 newMessages 形式回传（进度流不可用，
    // 决策面 Parity 见文件头注）。
    const hookFollowUps = await replayPostToolUseHooks(
      targetTool,
      input.params as Record<string, unknown>,
      targetResult.data,
      context,
      toolUseId,
    )

    return {
      ...targetResult,
      ...(hookFollowUps.length > 0
        ? {
            newMessages: [
              ...(targetResult.newMessages ?? []),
              ...hookFollowUps,
            ],
          }
        : {}),
      data: {
        result: targetResult.data,
        tool_name: input.tool_name,
      },
    }
  },
  async checkPermissions() {
    return {
      behavior: 'passthrough',
      message: 'ExecuteExtraTool delegates permission to the target tool.',
    }
  },
  renderToolUseMessage(input) {
    return `${input.tool_name}`
  },
  userFacingName() {
    return 'ExecuteExtraTool'
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(content),
    }
  },
  // Output shape: { result: <inner tool output>, tool_name: string }.
  // Delegate rendering to the inner tool when it defines its own
  // renderToolResultMessage so deferred tools can show their own UI
  // (e.g. ArtifactTool displays its uploaded URL). Without this, the
  // ExecuteExtraTool tool_result row renders nothing below the tool_use
  // line. The inner tool expects its own input shape, so unwrap params.
  //
  // Inline the lookup rather than calling findToolByName — deferred tools
  // are matched by exact name (no aliases needed), and avoiding the
  // shared helper keeps this method resilient to src/Tool.js mocks in
  // co-located test files (process-global mock.module pollution).
  renderToolResultMessage(content, progressMessages, options) {
    const innerTool = options.tools.find(t => t.name === content.tool_name)
    if (!innerTool?.renderToolResultMessage) return null
    // Guard against null/undefined result — several error branches in this
    // tool (tool-not-found, validation-failed, permission-denied, etc.) set
    // result: null, and delegating null to the inner tool's UI would crash
    // on any property access (e.g. output.worktreeBranch).
    if (content.result == null || typeof content.result !== 'object')
      return null
    const innerInput = (options.input as { params?: unknown } | undefined)
      ?.params
    return innerTool.renderToolResultMessage(
      content.result as never,
      progressMessages,
      {
        ...options,
        input: innerInput,
      },
    )
  },
} satisfies ToolDef<InputSchema, Output>)
