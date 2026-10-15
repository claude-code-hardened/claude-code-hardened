/**
 * Handback protocol (tier 1) — structured hand-back from a subagent to its
 * parent, gated by the HANDOFF_PROTOCOL feature flag (default off).
 *
 * Official reference (docs/reverse-284/decompiled, grep 'handback'):
 * - 0128-chunk-zrkp23rq/tools/agent.js: spawn threads the pair
 *   `handbackOptIn: !X` (X = isFork — forks never opt in) and
 *   `handbackTool: bYt` into the agent run; the finalize step then consumes
 *   `{handback, handbackReport}` produced by WPn.
 * - 0039-chunk-zrkp23rq/core/agent-loop.js: the completion result carries
 *   `handback` / `handbackReport` fields next to `content`, and the parent
 *   renders `{warning, kind}` blocks merged into the task result.
 * - Peer message origin carries `handback: true` with `senderTaskId` — the
 *   cross-agent delivery route (tier 2, out of scope here; see report).
 *
 * CCH tier-1 mapping:
 * - opt-in + visibility: HANDOFF_PROTOCOL && spawned-as-subagent (fork path
 *   excluded, mirroring `handbackOptIn: !X`). The tool is injected into the
 *   subagent's tool pool in AgentTool.call at spawn time — it never enters
 *   the main tool registry, so the main thread cannot see it. This mirrors
 *   the spirit of filterParentToolsForFork (spawn-time pool filtering).
 * - write path: the tool result text + a `structured_output` attachment
 *   (auto-emitted by toolExecution for `structured_output` tool results)
 *   carry the payload into the agent's message stream; the existing handoff
 *   consumers (finalizeAgentTool / classifyHandoffIfNeeded /
 *   enqueueAgentNotification) are unchanged.
 * - stop: runAgent watches the stream — once the tool_result of the Handback
 *   call has been yielded (plus any trailing attachments), the generator
 *   breaks before the next model turn. Equivalent to the official
 *   handback-then-stop behavior; no AbortError, so sync/async teardown paths
 *   all see a normal stream end.
 * - consumption: consumeHandback() surfaces the payload to the parent-facing
 *   result (sync: agentResult.content prefix; async: notification
 *   finalMessage prefix).
 *
 * This file stays PURE (schema/format/registry/stream predicates only, no
 * src/Tool.js or analytics imports) so it can be unit tested without mocks.
 */

import { z } from 'zod/v4'
import { lazySchema } from 'src/utils/lazySchema.js'

export const HANDBACK_TOOL_NAME = 'Handback' as const

/**
 * Free-form payload schema per the task brief: `summary` required,
 * findings/files/next_steps optional lists. Keep permissive — the payload is
 * opaque to the harness (forwarded verbatim as the structured report).
 */
export const handbackPayloadSchema = lazySchema(() =>
  z.object({
    summary: z.string().min(1),
    findings: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    next_steps: z.array(z.string()).optional(),
  }),
)
export type HandbackPayload = z.input<ReturnType<typeof handbackPayloadSchema>>

/**
 * Render the payload as the parent-facing text block. Deterministic key
 * order keeps prompt-cache behavior stable for structured reports.
 */
export function formatHandbackReport(payload: HandbackPayload): string {
  const lines: string[] = ['<handback>']
  lines.push(`summary: ${payload.summary}`)
  if (payload.findings?.length) {
    lines.push('findings:')
    for (const finding of payload.findings) lines.push(`- ${finding}`)
  }
  if (payload.files?.length) {
    lines.push('files:')
    for (const file of payload.files) lines.push(`- ${file}`)
  }
  if (payload.next_steps?.length) {
    lines.push('next_steps:')
    for (const step of payload.next_steps) lines.push(`- ${step}`)
  }
  lines.push('</handback>')
  return lines.join('\n')
}

// ── per-agent handback registry ────────────────────────────────────────────
// The tool records the payload under the executing (sub)agent's id; the
// sync result builder and the async notification builder consume it once.

const handbackByAgentId = new Map<string, HandbackPayload>()

export function recordHandback(
  agentId: string,
  payload: HandbackPayload,
): void {
  handbackByAgentId.set(agentId, payload)
}

/** Pop the recorded handback (if any) for this agent id. */
export function consumeHandback(agentId: string): HandbackPayload | undefined {
  const payload = handbackByAgentId.get(agentId)
  if (payload !== undefined) handbackByAgentId.delete(agentId)
  return payload
}

export function clearHandbacksForTest(): void {
  handbackByAgentId.clear()
}

// ── stream boundary helpers (used by runAgent) ─────────────────────────────

/**
 * Collect the tool_use ids of Handback calls from an assistant message so
 * the stream consumer knows which tool_result ends the turn. No-op for
 * non-assistant messages and messages without Handback tool_use blocks.
 */
export function collectHandbackToolUseIds(
  message: { type: string } & {
    message?: { content?: unknown }
  },
  toolUseIds: Set<string>,
): boolean {
  if (message.type !== 'assistant') return false
  const content = (message.message?.content ?? []) as Array<
    Record<string, unknown>
  >
  let found = false
  for (const block of content) {
    if (
      block?.type === 'tool_use' &&
      block.name === HANDBACK_TOOL_NAME &&
      typeof block.id === 'string'
    ) {
      toolUseIds.add(block.id)
      found = true
    }
  }
  return found
}

/**
 * True when the message is the tool_result the model produced for one of the
 * tracked Handback tool_use ids — the point where the agent's remaining
 * turns must be aborted (after yielding this message and any in-batch
 * attachments, i.e. the caller breaks on the next yielded message).
 */
export function isHandbackToolResult(
  message: { type: string } & { message?: { content?: unknown } },
  toolUseIds: ReadonlySet<string>,
): boolean {
  if (toolUseIds.size === 0) return false
  if (message.type !== 'user') return false
  const content = (message.message?.content ?? []) as Array<
    Record<string, unknown>
  >
  return content.some(
    block =>
      block?.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      toolUseIds.has(block.tool_use_id),
  )
}
