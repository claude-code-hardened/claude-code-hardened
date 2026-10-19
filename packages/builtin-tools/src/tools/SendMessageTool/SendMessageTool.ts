import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { isReplBridgeActive } from 'src/bootstrap/state.js'
import { getReplBridgeHandle } from 'src/bridge/replBridgeHandle.js'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { findTeammateTaskByAgentId } from 'src/tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
} from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from 'src/tasks/LocalMainSessionTask.js'
import { toAgentId } from 'src/types/ids.js'
import { generateRequestId } from 'src/utils/agentId.js'
import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from 'src/utils/errors.js'
import { truncate } from 'src/utils/format.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { parseAddress } from 'src/utils/peerAddress.js'
import { semanticBoolean } from 'src/utils/semanticBoolean.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { BackendType } from 'src/utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js'
import { readTeamFileAsync } from 'src/utils/swarm/teamHelpers.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
  isTeamLead,
  isTeammate,
} from 'src/utils/teammate.js'
import {
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  writeToMailbox,
} from 'src/utils/teammateMailbox.js'
import { resumeAgentBackground } from '../AgentTool/resumeAgent.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const StructuredMessage = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('shutdown_request'),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('shutdown_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('plan_approval_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      feedback: z.string().optional(),
    }),
  ]),
)

const inputSchema = lazySchema(() =>
  z.object({
    to: z
      .string()
      .describe(
        feature('UDS_INBOX')
          ? `Recipient: teammate name, "*" for broadcast, "uds:<socket-path>" for a local peer, "bridge:<session-id>" for a Remote Control peer${feature('LAN_PIPES') ? ', or "tcp:<host>:<port>" for a LAN peer' : ''} (use ListPeers to discover)`
          : 'Recipient: teammate name, or "*" for broadcast to all teammates',
      ),
    summary: z
      .string()
      .optional()
      .describe(
        'A 5-10 word summary shown as a preview in the UI (required when message is a string)',
      ),
    message: z.union([
      z.string().describe('Plain text message content'),
      StructuredMessage(),
    ]),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Input = z.infer<InputSchema>

export type MessageRouting = {
  sender: string
  senderColor?: string
  target: string
  targetColor?: string
  summary?: string
  content?: string
}

export type MessageOutput = {
  success: boolean
  message: string
  routing?: MessageRouting
}

export type BroadcastOutput = {
  success: boolean
  message: string
  recipients: string[]
  routing?: MessageRouting
}

export type RequestOutput = {
  success: boolean
  message: string
  request_id: string
  target: string
}

export type ResponseOutput = {
  success: boolean
  message: string
  request_id?: string
}

export type SendMessageToolOutput =
  | MessageOutput
  | BroadcastOutput
  | RequestOutput
  | ResponseOutput

const UDS_INLINE_TOKEN_MARKER = '#token='

// ── CCH #52 (R1-low / Q2 判定源收敛): 转发链护栏对齐官方 hop 准入 ─────────
// 官方真源（Q2 亲读原文）：
// - docs/reverse-284/decompiled/0258-chunk-116j5z58/module-005-uncategorized.js
//   :117 `Tan={...maxSelfHops:10,maxChainLength:28}` + :121 `g(d,o)`：链长 >
//   maxChainLength → "hop-runaway"；链中自会话 id 出现 ≥ maxSelfHops →
//   "hop-loop"。
// - 0001-chunk-xrzcaagk/module-006-uncategorized.js:2180 `_ge(e)`=e.origin
//   kind==='peer' 且无 senderTaskId；:2184 `b4e(e)`=
//   `e.verifiedPeerPid!==void 0||e.from!=="unknown"`；:9228 `vr()`：
//   `if(!_ge(sr))return Zpe` —— **非 peer origin 无条件放行**，hop 准入
//   （checkHopChain/admit）只对跨 transport 真 peer 生效；未识别 peer
//   （b4e===false）只查 hopChain，已识别 peer 才进 admit 的 senderKey 共存面。
// Q2 判定源收敛：上一版以发送方 agentId（getAgentId 未设与否）为判定源，
// 进程内 agent（同宿主进程）被计入 hops——过宽；bridge/uds/tcp 真 peer 又
// 被 transport 前置 return 直接漏检。现改为按**路由的宿主进程标记**判定：
// 同 process（进程内 agent 路由）→ 不参检不记账；跨 transport（bridge/
// uds/tcp 真 peer）→ 参检记账。peer 链为发送侧本进程可见面记账（官方
// hopChain 跨进程续链在接收面 vr/admit，CCH 未接线；同链同源重复发送的
// 链不增长，官方 admit() 共存面的近似——见 enforcePeerHopAdmission）。
// 自造的 forwardChain=5 单口径退役。
export const MAX_SELF_HOPS = 10
export const MAX_CHAIN_LENGTH = 28
/** 防泄漏：链表超过软上限时整体清零（重置后级联重新计数，护栏依然收敛）。 */
const FORWARD_CHAIN_MAP_SOFT_LIMIT = 256

const EMPTY_CHAIN: readonly string[] = Object.freeze([])

const forwardChains = new Map<string, readonly string[]>()

export type ForwardHopVerdict = {
  admitted: boolean
  reason?: 'hop-runaway' | 'hop-loop'
}

/** 官方 0258:121 g() 的链上自引计数（ownTokens ∩ hopChain）。 */
export function countSelfHops(
  chain: readonly string[],
  selfId: string,
): number {
  return chain.reduce((n, id) => (id === selfId ? n + 1 : n), 0)
}

/**
 * 官方 0258:121 g() 等价判定：链长超限 → "hop-runaway"；接收方自会话
 * 在链中出现 ≥ maxSelfHops 次（互踢循环）→ "hop-loop"。
 */
export function checkForwardHopAdmission(
  nextChain: readonly string[],
  receiverAgentId: string,
): ForwardHopVerdict {
  if (nextChain.length > MAX_CHAIN_LENGTH) {
    return { admitted: false, reason: 'hop-runaway' }
  }
  if (countSelfHops(nextChain, receiverAgentId) >= MAX_SELF_HOPS) {
    return { admitted: false, reason: 'hop-loop' }
  }
  return { admitted: true }
}

/**
 * CCH #52 hop 链读取（call() 内联护栏用；导出面供 SendMessageTool 的
 * forwardChain 单测在无 ToolUseContext 的环境下覆盖链数学——call() 路由
 * 分支依赖的 isLocalAgentTask 绑定在全量并发跑里会被
 * tests/mocks/localAgentTask 的 process-global mock 特化）。
 */
export function forwardChainOf(agentId: string | undefined): readonly string[] {
  return agentId !== undefined && agentId.length > 0
    ? (forwardChains.get(agentId) ?? EMPTY_CHAIN)
    : EMPTY_CHAIN
}

export function recordForwardChain(
  targetAgentId: string,
  chain: readonly string[],
): void {
  if (forwardChains.size >= FORWARD_CHAIN_MAP_SOFT_LIMIT) {
    forwardChains.clear()
  }
  forwardChains.set(targetAgentId, chain)
}

/** 测试缝：清转发链记账。 */
export function _resetForwardChainForTest(): void {
  forwardChains.clear()
}

/**
 * 官方 `_ge(origin)`（0001:2180）的 CCH 路由面等价判定：该 to 是否跨
 * transport 真 peer（origin.kind==='peer' 的发送/投递对应物）。进程内
 * agent 路由（裸名 / raw agentId）不是 peer——同宿主进程不计 hops。
 */
export type CrossTransportPeerRoute = {
  kind: 'uds' | 'tcp' | 'bridge'
  /** 链记账键：去 token 的 transport 地址（uds:/…、tcp:host:port、bridge:id）。 */
  peerKey: string
}

export function crossTransportPeerRoute(
  to: string,
): CrossTransportPeerRoute | undefined {
  const addr = parseAddress(to)
  switch (addr.scheme) {
    case 'uds':
      return {
        kind: 'uds',
        // 记账键不带 inline token（与展示面同一脱敏），token 探针不入链。
        peerKey: `uds:${stripInlineUdsToken(addr.target)}`,
      }
    case 'tcp':
      return { kind: 'tcp', peerKey: `tcp:${addr.target}` }
    case 'bridge':
      return { kind: 'bridge', peerKey: `bridge:${addr.target}` }
    default:
      return undefined
  }
}

/** 发送侧链 link（官方 hopChain 的链节点）：进程内发送者 id；主会话无
 * agentId 时用哨兵 id（同 host 面内稳定可计数）。 */
export function senderHopLink(): string {
  return getAgentId() || 'main-session'
}

/**
 * 跨 transport 真 peer 的 hop 准入（官方 0001:9228 vr() 对
 * _ge(origin)===true 命令的 checkHopChain/send-side 近似）：
 * nextChain = 该 peer 的已记账链 + 本发送者 link，链长/自引双口径
 * （0258:121 g()）判定；admits 才记账，且**链与已记账值完全一致时不重复
 * 记**（同链同源重复发送不增长——官方 admit() 的 senderKey 共存面近似）。
 * 被拒时返回与 call() 其余拒绝分支同形的失败结果。
 */
export function enforcePeerHopAdmission(
  route: CrossTransportPeerRoute,
): { data: { success: false; message: string } } | undefined {
  const existing = forwardChainOf(route.peerKey)
  const link = senderHopLink()
  const nextChain = existing.at(-1) === link ? existing : [...existing, link]
  const verdict = checkForwardHopAdmission(nextChain, route.peerKey)
  if (!verdict.admitted) {
    logForDebugging(
      `[SendMessageTool] forward chain rejected (${verdict.reason}) sending to peer ${route.peerKey} (chain=${nextChain.join('->')})`,
    )
    const detail =
      verdict.reason === 'hop-runaway'
        ? `forward chain exceeded the max length (${nextChain.length} hops > ${MAX_CHAIN_LENGTH})`
        : `the message would pass through ${route.peerKey} a ${countSelfHops(nextChain, route.peerKey) + 1}th time, exceeding max self-hops (${MAX_SELF_HOPS})`
    return {
      data: {
        success: false,
        message: `Forward rejected (${verdict.reason}): ${detail} — not forwarding to ${route.peerKey}. Deliver your result back to the requester instead of relaying.`,
      },
    }
  }
  if (nextChain !== existing) {
    recordForwardChain(route.peerKey, nextChain)
  }
  return undefined
}

function stripInlineUdsToken(target: string): string {
  const markerIndex = target.indexOf(UDS_INLINE_TOKEN_MARKER)
  return markerIndex === -1 ? target : target.slice(0, markerIndex)
}

function hasInlineUdsToken(to: string): boolean {
  const addr = parseAddress(to)
  // Empty-token markers are still inline-token attempts. Observable input
  // redaction preserves "#token=" so cloned inputs remain rejected.
  return addr.scheme === 'uds' && addr.target.includes(UDS_INLINE_TOKEN_MARKER)
}

function recipientForDisplay(to: string): string {
  const addr = parseAddress(to)
  if (addr.scheme !== 'uds') return to
  return `uds:${stripInlineUdsToken(addr.target)}`
}

function redactInlineUdsTokenForRejection(to: string): string {
  const addr = parseAddress(to)
  if (addr.scheme !== 'uds') return to
  const markerIndex = addr.target.indexOf(UDS_INLINE_TOKEN_MARKER)
  if (markerIndex === -1) return to
  return `uds:${addr.target.slice(0, markerIndex)}${UDS_INLINE_TOKEN_MARKER}`
}

function redactObservableInlineUdsToken(input: { to: string }): void {
  if (!hasInlineUdsToken(input.to)) return
  input.to = redactInlineUdsTokenForRejection(input.to)
}

function findTeammateColor(
  appState: {
    teamContext?: { teammates: { [id: string]: { color?: string } } }
  },
  name: string,
): string | undefined {
  const teammates = appState.teamContext?.teammates
  if (!teammates) return undefined
  for (const teammate of Object.values(teammates)) {
    if ('name' in teammate && (teammate as { name: string }).name === name) {
      return teammate.color
    }
  }
  return undefined
}

async function handleMessage(
  recipientName: string,
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: MessageOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  const senderColor = getTeammateColor()

  await writeToMailbox(
    recipientName,
    {
      from: senderName,
      text: content,
      summary,
      timestamp: new Date().toISOString(),
      color: senderColor,
    },
    teamName,
  )

  const recipientColor = findTeammateColor(appState, recipientName)

  return {
    data: {
      success: true,
      message: `Message sent to ${recipientName}'s inbox`,
      routing: {
        sender: senderName,
        senderColor,
        target: `@${recipientName}`,
        targetColor: recipientColor,
        summary,
        content,
      },
    },
  }
}

async function handleBroadcast(
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: BroadcastOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)

  if (!teamName) {
    throw new Error(
      'Not in a team context. Create a team with Teammate spawnTeam first, or set CLAUDE_CODE_TEAM_NAME.',
    )
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(`Team "${teamName}" does not exist`)
  }

  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  if (!senderName) {
    throw new Error(
      'Cannot broadcast: sender name is required. Set CLAUDE_CODE_AGENT_NAME.',
    )
  }

  const senderColor = getTeammateColor()

  const recipients: string[] = []
  for (const member of teamFile.members) {
    if (member.name.toLowerCase() === senderName.toLowerCase()) {
      continue
    }
    recipients.push(member.name)
  }

  if (recipients.length === 0) {
    return {
      data: {
        success: true,
        message: 'No teammates to broadcast to (you are the only team member)',
        recipients: [],
      },
    }
  }

  for (const recipientName of recipients) {
    await writeToMailbox(
      recipientName,
      {
        from: senderName,
        text: content,
        summary,
        timestamp: new Date().toISOString(),
        color: senderColor,
      },
      teamName,
    )
  }

  return {
    data: {
      success: true,
      message: `Message broadcast to ${recipients.length} teammate(s): ${recipients.join(', ')}`,
      recipients,
      routing: {
        sender: senderName,
        senderColor,
        target: '@team',
        summary,
        content,
      },
    },
  }
}

async function handleShutdownRequest(
  targetName: string,
  reason: string | undefined,
  context: ToolUseContext,
): Promise<{ data: RequestOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  const senderName = getAgentName() || TEAM_LEAD_NAME
  const requestId = generateRequestId('shutdown', targetName)

  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: senderName,
    reason,
  })

  await writeToMailbox(
    targetName,
    {
      from: senderName,
      text: jsonStringify(shutdownMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown request sent to ${targetName}. Request ID: ${requestId}`,
      request_id: requestId,
      target: targetName,
    },
  }
}

async function handleShutdownApproval(
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName() || 'teammate'

  logForDebugging(
    `[SendMessageTool] handleShutdownApproval: teamName=${teamName}, agentId=${agentId}, agentName=${agentName}`,
  )

  let ownPaneId: string | undefined
  let ownBackendType: BackendType | undefined
  if (teamName) {
    const teamFile = await readTeamFileAsync(teamName)
    if (teamFile && agentId) {
      const selfMember = teamFile.members.find(m => m.agentId === agentId)
      if (selfMember) {
        ownPaneId = selfMember.tmuxPaneId
        ownBackendType = selfMember.backendType
      }
    }
  }

  const approvedMessage = createShutdownApprovedMessage({
    requestId,
    from: agentName,
    paneId: ownPaneId,
    backendType: ownBackendType,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(approvedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  if (ownBackendType === 'in-process') {
    logForDebugging(
      `[SendMessageTool] In-process teammate ${agentName} approving shutdown - signaling abort`,
    )

    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        task.abortController.abort()
        logForDebugging(
          `[SendMessageTool] Aborted controller for in-process teammate ${agentName}`,
        )
      } else {
        logForDebugging(
          `[SendMessageTool] Warning: Could not find task/abortController for ${agentName}`,
        )
      }
    }
  } else {
    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        logForDebugging(
          `[SendMessageTool] Fallback: Found in-process task for ${agentName} via AppState, aborting`,
        )
        task.abortController.abort()

        return {
          data: {
            success: true,
            message: `Shutdown approved (fallback path). Agent ${agentName} is now exiting.`,
            request_id: requestId,
          },
        }
      }
    }

    setImmediate(async () => {
      await gracefulShutdown(0, 'other')
    })
  }

  return {
    data: {
      success: true,
      message: `Shutdown approved. Sent confirmation to team-lead. Agent ${agentName} is now exiting.`,
      request_id: requestId,
    },
  }
}

async function handleShutdownRejection(
  requestId: string,
  reason: string,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentName = getAgentName() || 'teammate'

  const rejectedMessage = createShutdownRejectedMessage({
    requestId,
    from: agentName,
    reason,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(rejectedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown rejected. Reason: "${reason}". Continuing to work.`,
      request_id: requestId,
    },
  }
}

async function handlePlanApproval(
  recipientName: string,
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can approve plans. Teammates cannot approve their own or other plans.',
    )
  }

  const leaderMode = appState.toolPermissionContext.mode
  const modeToInherit = leaderMode === 'plan' ? 'default' : leaderMode

  const approvalResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: true,
    timestamp: new Date().toISOString(),
    permissionMode: modeToInherit,
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(approvalResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan approved for ${recipientName}. They will receive the approval and can proceed with implementation.`,
      request_id: requestId,
    },
  }
}

async function handlePlanRejection(
  recipientName: string,
  requestId: string,
  feedback: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can reject plans. Teammates cannot reject their own or other plans.',
    )
  }

  const rejectionResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: false,
    feedback,
    timestamp: new Date().toISOString(),
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(rejectionResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan rejected for ${recipientName} with feedback: "${feedback}"`,
      request_id: requestId,
    },
  }
}

export const SendMessageTool: Tool<InputSchema, SendMessageToolOutput> =
  buildTool({
    name: SEND_MESSAGE_TOOL_NAME,
    searchHint:
      'send message to teammate agent, broadcast, inter-agent communication, swarm messaging, agent coordination',
    maxResultSizeChars: 100_000,

    userFacingName() {
      return 'SendMessage'
    },

    get inputSchema(): InputSchema {
      return inputSchema()
    },
    shouldDefer: true,
    alwaysLoad: isAgentSwarmsEnabled(),

    isEnabled() {
      return true
    },

    isReadOnly(input) {
      return typeof input.message === 'string'
    },

    backfillObservableInput(input) {
      if (typeof input.to !== 'string') return

      redactObservableInlineUdsToken(input as { to: string })
      if ('type' in input) return

      if (input.to === '*') {
        input.type = 'broadcast'
        if (typeof input.message === 'string') input.content = input.message
      } else if (typeof input.message === 'string') {
        input.type = 'message'
        input.recipient = recipientForDisplay(input.to)
        input.content = input.message
      } else if (typeof input.message === 'object' && input.message !== null) {
        const msg = input.message as {
          type?: string
          request_id?: string
          approve?: boolean
          reason?: string
          feedback?: string
        }
        input.type = msg.type
        input.recipient = recipientForDisplay(input.to)
        if (msg.request_id !== undefined) input.request_id = msg.request_id
        if (msg.approve !== undefined) input.approve = msg.approve
        const content = msg.reason ?? msg.feedback
        if (content !== undefined) input.content = content
      }
    },

    toAutoClassifierInput(input) {
      const recipient = recipientForDisplay(input.to)
      if (typeof input.message === 'string') {
        return `to ${recipient}: ${input.message}`
      }
      switch (input.message.type) {
        case 'shutdown_request':
          return `shutdown_request to ${recipient}`
        case 'shutdown_response':
          return `shutdown_response ${input.message.approve ? 'approve' : 'reject'} ${input.message.request_id}`
        case 'plan_approval_response':
          return `plan_approval ${input.message.approve ? 'approve' : 'reject'} to ${recipient}`
      }
    },

    async checkPermissions(input, _context) {
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        return {
          behavior: 'ask' as const,
          message: `Send a message to Remote Control session ${input.to}? It arrives as a user prompt on the receiving Claude (possibly another machine) via Anthropic's servers.`,
          decisionReason: {
            type: 'safetyCheck',
            reason:
              'Cross-machine bridge message requires explicit user consent',
            classifierApprovable: false,
          },
        }
      }
      if (feature('LAN_PIPES') && parseAddress(input.to).scheme === 'tcp') {
        return {
          behavior: 'ask' as const,
          message: `Send a message to LAN peer ${input.to}? This connects directly over TCP to a machine on your local network.`,
          decisionReason: {
            type: 'safetyCheck',
            reason: 'Cross-machine LAN message requires explicit user consent',
            classifierApprovable: false,
          },
        }
      }
      return { behavior: 'allow' as const, updatedInput: input }
    },

    async validateInput(input, _context) {
      if (input.to.trim().length === 0) {
        return {
          result: false,
          message: 'to must not be empty',
          errorCode: 9,
        }
      }
      const addr = parseAddress(input.to)
      if (
        (addr.scheme === 'bridge' ||
          addr.scheme === 'uds' ||
          addr.scheme === 'tcp') &&
        addr.target.trim().length === 0
      ) {
        return {
          result: false,
          message: 'address target must not be empty',
          errorCode: 9,
        }
      }
      if (addr.scheme === 'uds' && hasInlineUdsToken(input.to)) {
        return {
          result: false,
          message:
            'uds addresses must not include inline auth tokens; use the ListPeers address',
          errorCode: 9,
        }
      }
      if (input.to.includes('@')) {
        return {
          result: false,
          message:
            'to must be a bare teammate name or "*" — there is only one team per session',
          errorCode: 9,
        }
      }
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        // Structured-message rejection first — it's the permanent constraint.
        // Showing "not connected" first would make the user reconnect only to
        // hit this error on retry.
        if (typeof input.message !== 'string') {
          return {
            result: false,
            message:
              'structured messages cannot be sent cross-session — only plain text',
            errorCode: 9,
          }
        }
        // postInterClaudeMessage derives from= via getReplBridgeHandle() —
        // check handle directly for the init-timing window. Also check
        // isReplBridgeActive() to reject outbound-only (CCR mirror) mode
        // where the bridge is write-only and peer messaging is unsupported.
        if (!getReplBridgeHandle() || !isReplBridgeActive()) {
          return {
            result: false,
            message:
              'Remote Control is not connected — cannot send to a bridge: target. Reconnect with /remote-control first.',
            errorCode: 9,
          }
        }
        return { result: true }
      }
      if (
        feature('UDS_INBOX') &&
        parseAddress(input.to).scheme === 'uds' &&
        typeof input.message === 'string'
      ) {
        return { result: true }
      }
      if (
        feature('LAN_PIPES') &&
        parseAddress(input.to).scheme === 'tcp' &&
        typeof input.message === 'string'
      ) {
        return { result: true }
      }
      if (typeof input.message === 'string') {
        if (!input.summary || input.summary.trim().length === 0) {
          return {
            result: false,
            message: 'summary is required when message is a string',
            errorCode: 9,
          }
        }
        return { result: true }
      }

      if (input.to === '*') {
        return {
          result: false,
          message: 'structured messages cannot be broadcast (to: "*")',
          errorCode: 9,
        }
      }
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme !== 'other') {
        return {
          result: false,
          message:
            'structured messages cannot be sent cross-session — only plain text',
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        input.to !== TEAM_LEAD_NAME
      ) {
        return {
          result: false,
          message: `shutdown_response must be sent to "${TEAM_LEAD_NAME}"`,
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        !input.message.approve &&
        (!input.message.reason || input.message.reason.trim().length === 0)
      ) {
        return {
          result: false,
          message: 'reason is required when rejecting a shutdown request',
          errorCode: 9,
        }
      }

      return { result: true }
    },

    async description() {
      return DESCRIPTION
    },

    async prompt() {
      return getPrompt()
    },

    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [
          {
            type: 'text' as const,
            text: jsonStringify(data),
          },
        ],
      }
    },

    async call(input, context, canUseTool, assistantMessage) {
      if (typeof input.message === 'string') {
        const addr = parseAddress(input.to)
        if (addr.scheme === 'uds' && hasInlineUdsToken(input.to)) {
          return {
            data: {
              success: false,
              message:
                'uds addresses must not include inline auth tokens; use the ListPeers address',
            },
          }
        }
      }

      if (feature('UDS_INBOX') && typeof input.message === 'string') {
        const addr = parseAddress(input.to)
        if (addr.scheme === 'bridge') {
          // Re-check handle — checkPermissions blocks on user approval (can be
          // minutes). validateInput's check is stale if the bridge dropped
          // during the prompt wait; without this, from="unknown" ships.
          // Also re-check isReplBridgeActive for outbound-only mode.
          if (!getReplBridgeHandle() || !isReplBridgeActive()) {
            return {
              data: {
                success: false,
                message: `Remote Control disconnected before send — cannot deliver to ${input.to}`,
              },
            }
          }
          // W1.3（Q2）：bridge 真 peer 参检 hop 准入（上一版 transport
          // 前置 return 漏检；官方 vr 只对 _ge peer origin 参检）。
          const peerRejection = enforcePeerHopAdmission(
            crossTransportPeerRoute(input.to)!,
          )
          if (peerRejection) return peerRejection
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { postInterClaudeMessage } =
            require('src/bridge/peerSessions.js') as typeof import('src/bridge/peerSessions.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          const result = (await postInterClaudeMessage(
            addr.target,
            input.message,
          )) as { ok: boolean; error?: string }
          const preview = input.summary || truncate(input.message, 50)
          return {
            data: {
              success: result.ok,
              message: result.ok
                ? `”${preview}” → ${input.to}`
                : `Failed to send to ${input.to}: ${result.error ?? 'unknown'}`,
            },
          }
        }
        if (addr.scheme === 'uds') {
          // W1.3（Q2）：uds 真 peer 参检 hop 准入（官方 _ge origin 对应面）。
          const peerRejection = enforcePeerHopAdmission(
            crossTransportPeerRoute(input.to)!,
          )
          if (peerRejection) return peerRejection
          const recipient = recipientForDisplay(input.to)
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { sendToUdsSocket } =
            require('src/utils/udsClient.js') as typeof import('src/utils/udsClient.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          try {
            await sendToUdsSocket(addr.target, input.message)
            const preview = input.summary || truncate(input.message, 50)
            return {
              data: {
                success: true,
                message: `”${preview}” → ${recipient}`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `Failed to send to ${recipient}: ${errorMessage(e)}`,
              },
            }
          }
        }
        if (addr.scheme === 'tcp' && feature('LAN_PIPES')) {
          const { parseTcpTarget } =
            require('src/utils/peerAddress.js') as typeof import('src/utils/peerAddress.js')
          const { PipeClient } =
            require('src/utils/pipeTransport.js') as typeof import('src/utils/pipeTransport.js')
          const ep = parseTcpTarget(addr.target)
          if (!ep) {
            return {
              data: {
                success: false,
                message: `Invalid TCP target format: ${addr.target}. Expected host:port`,
              },
            }
          }
          // W1.3（Q2）：tcp LAN 真 peer 参检 hop 准入。
          const peerRejection = enforcePeerHopAdmission(
            crossTransportPeerRoute(input.to)!,
          )
          if (peerRejection) return peerRejection
          try {
            const client = new PipeClient(input.to, `send-${process.pid}`, ep)
            await client.connect(5000)
            client.send({ type: 'chat', data: input.message })
            client.disconnect()
            const preview = input.summary || truncate(input.message, 50)
            return {
              data: {
                success: true,
                message: `”${preview}” → ${input.to} (TCP ${ep.host}:${ep.port})`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `Failed to send via TCP to ${input.to}: ${errorMessage(e)}`,
              },
            }
          }
        }
      }

      // Route to in-process subagent by name or raw agentId before falling
      // through to ambient-team resolution. Stopped agents are auto-resumed.
      if (typeof input.message === 'string' && input.to !== '*') {
        const appState = context.getAppState()
        const registered = appState.agentNameRegistry.get(input.to)
        const agentId = registered ?? toAgentId(input.to)
        if (agentId) {
          // W1.3（Q2 判定源收敛）：进程内 agent → 进程内 agent 是同宿主
          // 进程路由——官方 vr()（0001:9228）`if(!_ge(sr))return Zpe` 对
          // 非 peer origin 无条件放行，**不参检、不记账 hops**。上一版以
          // 发送方 agentId 为判定源把进程内转发也计入链（过宽），已退役；
          // hop 准入只在 bridge/uds/tcp 真 peer 的 transport 分支执行。
          const task = appState.tasks[agentId]
          if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
            if (task.status === 'running') {
              queuePendingMessage(
                agentId,
                input.message,
                context.setAppStateForTasks ?? context.setAppState,
              )
              return {
                data: {
                  success: true,
                  message: `Message queued for delivery to ${input.to} at its next tool round.`,
                },
              }
            }
            // task exists but stopped — auto-resume
            try {
              const result = await resumeAgentBackground({
                agentId,
                prompt: input.message,
                toolUseContext: context,
                canUseTool,
                invokingRequestId: assistantMessage?.requestId as
                  | string
                  | undefined,
              })
              return {
                data: {
                  success: true,
                  message: `Agent "${input.to}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
                },
              }
            } catch (e) {
              return {
                data: {
                  success: false,
                  message: `Agent "${input.to}" is stopped (${task.status}) and could not be resumed: ${errorMessage(e)}`,
                },
              }
            }
          } else {
            // task evicted from state — try resume from disk transcript.
            // agentId is either a registered name or a format-matching raw ID
            // (toAgentId validates the createAgentId format, so teammate names
            // never reach this block).
            try {
              const result = await resumeAgentBackground({
                agentId,
                prompt: input.message,
                toolUseContext: context,
                canUseTool,
                invokingRequestId: assistantMessage?.requestId as
                  | string
                  | undefined,
              })
              return {
                data: {
                  success: true,
                  message: `Agent "${input.to}" had no active task; resumed from transcript in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
                },
              }
            } catch (e) {
              return {
                data: {
                  success: false,
                  message: `Agent "${input.to}" is registered but has no transcript to resume. It may have been cleaned up. (${errorMessage(e)})`,
                },
              }
            }
          }
        }
      }

      if (typeof input.message === 'string') {
        if (input.to === '*') {
          return handleBroadcast(input.message, input.summary, context)
        }
        return handleMessage(input.to, input.message, input.summary, context)
      }

      if (input.to === '*') {
        throw new Error('structured messages cannot be broadcast')
      }

      switch (input.message.type) {
        case 'shutdown_request':
          return handleShutdownRequest(input.to, input.message.reason, context)
        case 'shutdown_response':
          if (input.message.approve) {
            return handleShutdownApproval(input.message.request_id, context)
          }
          return handleShutdownRejection(
            input.message.request_id,
            input.message.reason!,
          )
        case 'plan_approval_response':
          if (input.message.approve) {
            return handlePlanApproval(
              input.to,
              input.message.request_id,
              context,
            )
          }
          return handlePlanRejection(
            input.to,
            input.message.request_id,
            input.message.feedback ?? 'Plan needs revision',
            context,
          )
      }
    },

    renderToolUseMessage,
    renderToolResultMessage,
  } satisfies ToolDef<InputSchema, SendMessageToolOutput>)
