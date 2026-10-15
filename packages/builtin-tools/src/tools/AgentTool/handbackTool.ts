/**
 * HandbackTool — the subagent-facing tool of the handback protocol (tier 1).
 *
 * Only ever injected into a subagent's tool pool (AgentTool.call, regular
 * non-fork spawns, HANDOFF_PROTOCOL on) — it is not registered in the main
 * tool registry, so the main thread never sees it, matching the official
 * opt-in pairing `handbackOptIn: !X` / `handbackTool: bYt`
 * (0128-chunk-zrkp23rq/tools/agent.js: X = isFork, so forks never opt in).
 *
 * On call it validates the payload, records it for the finalize consumers
 * (recordHandback) and returns the report text plus a `structured_output`
 * field — toolExecution turns that into a structured_output attachment, so
 * the payload lands in the agent's message stream (the same channel
 * SyntheticOutputTool uses). runAgent then aborts the agent's remaining
 * turns once this tool_result has been streamed.
 */
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from 'src/Tool.js'
import { logForDebugging } from 'src/utils/debug.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import {
  HANDBACK_TOOL_NAME,
  formatHandbackReport,
  handbackPayloadSchema,
  recordHandback,
  type HandbackPayload,
} from './handback.js'

const inputSchema = lazySchema(() => handbackPayloadSchema())
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  handbackPayloadSchema().extend({
    status: z.literal('handed_back'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type HandbackOutput = z.output<OutputSchema>

export const handbackTool = buildTool({
  isMcp: false,
  isEnabled() {
    // Instance-level gate: pool membership is decided at spawn time by the
    // HANDOFF_PROTOCOL injection in AgentTool.call. Once placed in a pool,
    // always enabled.
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  isOpenWorld() {
    return false
  },
  name: HANDBACK_TOOL_NAME,
  searchHint: 'hand the task back to the parent agent with a structured report',
  maxResultSizeChars: 100_000,
  async description(): Promise<string> {
    return 'Hand the task back to the parent agent with a structured report'
  },
  async prompt(): Promise<string> {
    return (
      'Hand this task back to the parent agent with a structured report. ' +
      'Provide `summary` (required), plus optional `findings`, `files` and ' +
      '`next_steps` lists. Calling this tool ends your run: do not call it ' +
      'until your work is complete (or irrecoverably blocked), and never ' +
      'call it more than once.'
    )
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input: HandbackPayload, toolUseContext: ToolUseContext) {
    const agentId = toolUseContext.agentId
    if (agentId !== undefined) {
      recordHandback(agentId, input)
    }
    logForDebugging(
      `[Handback] agent ${agentId ?? 'unknown'} handed back: ${input.summary.slice(0, 200)}`,
    )
    // The tool result echoes the full payload so mapToolResult /
    // renderToolResultMessage can rebuild the report for the transcript.
    return {
      data: {
        status: 'handed_back' as const,
        ...input,
      },
      structured_output: input,
    }
  },
  async checkPermissions(input: HandbackPayload): Promise<PermissionResult> {
    // The handback is the subagent's structured return channel — never prompt.
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage(input: Partial<HandbackPayload>) {
    const summary = input.summary
    return typeof summary === 'string' ? summary : null
  },
  renderToolUseRejectedMessage() {
    return 'Handback rejected'
  },
  renderToolUseErrorMessage() {
    return 'Handback error'
  },
  renderToolUseProgressMessage() {
    return null
  },
  renderToolResultMessage(output: HandbackOutput) {
    return formatHandbackReport(output)
  },
  mapToolResultToToolResultBlockParam(data: HandbackOutput, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content:
        `Handback accepted. The structured report below has been recorded and ` +
        `will be delivered to the parent agent.\n\n${formatHandbackReport(data)}\n\n` +
        `Stop now — do not take any further action.`,
    }
  },
} satisfies ToolDef<InputSchema, HandbackOutput>)
