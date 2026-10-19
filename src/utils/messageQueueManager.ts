import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { Permutations } from 'src/types/utils.js'
import { getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type {
  QueueOperation,
  QueueOperationMessage,
} from '../types/messageQueueTypes.js'
import type {
  EditablePromptInputMode,
  PromptInputMode,
  QueuedCommand,
  QueuePriority,
} from '../types/textInputTypes.js'
import type { PastedContent } from './config.js'
import { logForDebugging } from './debug.js'
import { extractTextContent } from './messages.js'
import { objectGroupBy } from './objectGroupBy.js'
import { recordQueueOperation } from './sessionStorage.js'
import { createSignal } from './signal.js'

export type SetAppState = (f: (prev: AppState) => AppState) => void

// ============================================================================
// Notification envelope facets (CCH #50/#52 官方队列命令形状对齐)
// ============================================================================

/**
 * CCH #50/#52 (官方 2.1.284 队列命令信封字段——
 * docs/reverse-284/0001-chunk-xrzcaagk/module-006-uncategorized.js:2295
 * `Eyo` 的命令形状 {mode:'task-notification',skipAttachments,priority,
 * agentId,taskId,userResumeNotice,passive})：通知类命令在 QueuedCommand
 * 之上可携带的 mailbox 三面标记。
 */
export type NotificationCommandOptions = {
  /**
   * CCH #50 插队面：true 时插到队列首（优先于既有待处理命令），
   * 而非按默认的 FIFO/priority 追加。写路径已由 enqueuePendingNotification
   * 消费（unshift），测试面覆盖；生产 sender 尚未接线（pending wiring，
   * 官方 Er 的 ahead 走 enqueueReportingAdmission 的 peer 收条面——CCH
   * peer 链尚未打通，勿在无官方出出处强行挂用）。
   */
  ahead?: boolean
  /**
   * CCH #50/#46 静默面：官方 passive（module-006:2200 lh / :2208 P8）=
   * 「入上下文但不计入 hasUserIntent（官方 so()=hasUserIntentCommandsInQueue
   * 里被 `passive!==!0` 排除，module-006:9229）、不触发新 query 轮」。
   * 消费面：isUserIntentCommand / hasUserIntentCommandsInQueue（不 wake）+
   * 渲染面（预览 isQueuedCommandVisible / UserAgentNotificationMessage 通知
   * pill）静默；消息本体照常投递给模型。官方只在"目标是当前主会话的
   * userResumeNotice"上置位（`...r===qe()&&{passive:!0}`）。
   */
  passive?: boolean
  /**
   * CCH #50 官方 skipAttachments：官方 Trt（module-006:2116，poll-event /
   * task-notification / skipAttachments===!0 的命令不参与附件收集）——
   * CCH 消费点在 getQueuedCommandAttachments（src/utils/attachments.ts）：
   * 命中即跳过图片块收集（文本本体照进上下文）。官方 resume/bulk 通知
   * 均带 `skipAttachments:!0`。
   */
  skipAttachments?: boolean
  /**
   * W1.5（Q2）：官方信封字段 `agentId:r`（0001/module-006:2295 `Eyo` 的
   * `agentId:r` = 目标会话路由位）。上一版信封类型缺该字段（F4 顾虑）。
   * CCH 主线程消费面（print.ts dequeue/isMainThread、query.ts 子代理
   * mid-turn 摘取）以 `cmd.agentId === undefined` 判主线程——**在本会话
   * 内自投**的通知（userResumeNotice、still-running 快照）必须留空，
   * 否则永远无人投递（F4 顾虑复核为真实，保 payload tag 面 +
   * AgentTool/userResumeNotice.ts 头注释的官方差异声明）；跨会话/子代理
   * 定向投递的生产者（官方按 `agentId:r` 路由的信使）才携带本字段。
   */
  agentId?: string
  /** 关联任务 id（官方命令形状携带；供消费面/去重判定）。 */
  taskId?: string
  /** CCH #46: 官方 userResumeNotice 标记（复活通知；配合模块级去重）。 */
  userResumeNotice?: boolean
}

/** 携带 mailbox 信封字段的队列命令。 */
export type NotificationCommand = QueuedCommand & NotificationCommandOptions

/** CCH #50 静默面读取。 */
export function isPassiveNotification(cmd: QueuedCommand): boolean {
  return (cmd as NotificationCommand).passive === true
}

/**
 * CCH #50/#52 消费面判定（官方 lh/P8 等价，module-006:2200/2208）：
 * 该命令是否算 user intent。passive 通知入上下文但不算 user intent。
 */
export function isUserIntentCommand(cmd: QueuedCommand): boolean {
  return !isPassiveNotification(cmd)
}

/**
 * CCH #50 官方 so()（hasUserIntentCommandsInQueue，module-006:9229
 * `g.some(Ro=>!_b(Ro)&&Ro.passive!==!0)`）的 CCH 等价：队列里是否还有
 * 会触发新 query 轮的 user-intent 命令。passive 通知被排除——纯 passive
 * 队列不 wake（useQueueProcessor 消费点）。
 * （CCH 无 poll-event 形态，_b 排除项不适用。）
 */
export function hasUserIntentCommandsInQueue(): boolean {
  return commandQueue.some(isUserIntentCommand)
}

/** CCH #50 skipAttachments 信封读取（官方 processUserInput face 的消费形）。 */
export function shouldSkipAttachmentsForCommand(cmd: QueuedCommand): boolean {
  return (cmd as NotificationCommand).skipAttachments === true
}

// ============================================================================
// Logging helper
// ============================================================================

function logOperation(operation: QueueOperation, content?: string): void {
  const sessionId = getSessionId()
  const queueOp: QueueOperationMessage = {
    type: 'queue-operation',
    operation,
    timestamp: new Date().toISOString(),
    sessionId,
    ...(content !== undefined && { content }),
  }
  void recordQueueOperation(queueOp)
}

// ============================================================================
// Unified command queue (module-level, independent of React state)
//
// All commands — user input, task notifications, orphaned permissions — go
// through this single queue. React components subscribe via
// useSyncExternalStore (subscribeToCommandQueue / getCommandQueueSnapshot).
// Non-React code (print.ts streaming loop) reads directly via
// getCommandQueue() / getCommandQueueLength().
//
// Priority determines dequeue order: 'now' > 'next' > 'later'.
// Within the same priority, commands are processed FIFO.
// ============================================================================

const commandQueue: QueuedCommand[] = []
/** Frozen snapshot — recreated on every mutation for useSyncExternalStore. */
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const queueChanged = createSignal()

function notifySubscribers(): void {
  snapshot = Object.freeze([...commandQueue])
  queueChanged.emit()
}

// ============================================================================
// useSyncExternalStore interface
// ============================================================================

/**
 * Subscribe to command queue changes.
 * Compatible with React's useSyncExternalStore.
 */
export const subscribeToCommandQueue = queueChanged.subscribe

/**
 * Get current snapshot of the command queue.
 * Compatible with React's useSyncExternalStore.
 * Returns a frozen array that only changes reference on mutation.
 */
export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

// ============================================================================
// Read operations (for non-React code)
// ============================================================================

/**
 * Get a mutable copy of the current queue.
 * Use for one-off reads where you need the actual commands.
 */
export function getCommandQueue(): QueuedCommand[] {
  return [...commandQueue]
}

/**
 * Get the current queue length without copying.
 */
export function getCommandQueueLength(): number {
  return commandQueue.length
}

/**
 * Check if there are commands in the queue.
 */
export function hasCommandsInQueue(): boolean {
  return commandQueue.length > 0
}

/**
 * Trigger a re-check by notifying subscribers.
 * Use after async processing completes to ensure remaining commands
 * are picked up by useSyncExternalStore consumers.
 */
export function recheckCommandQueue(): void {
  if (commandQueue.length > 0) {
    notifySubscribers()
  }
}

// ============================================================================
// Write operations
// ============================================================================

/**
 * Add a command to the queue.
 * Used for user-initiated commands (prompt, bash, orphaned-permission).
 * Defaults priority to 'next' (processed before task notifications).
 */
export function enqueue(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'next' })
  notifySubscribers()
  logOperation(
    'enqueue',
    typeof command.value === 'string' ? command.value : undefined,
  )
}

/**
 * Add a task notification to the queue.
 * Convenience wrapper that defaults priority to 'later' so user input
 * is never starved by system messages.
 *
 * CCH #50 mailbox 三面（NotificationCommandOptions）：
 *  - `ahead: true`      插队到队列首（unshift），不等既有待处理命令；
 *  - `passive: true`    渲染面（预览/ pill）静默不弹提示；
 *  - `skipAttachments`  信封声明，构造处/消费面跳过 attachment 收集。
 *
 * CCH #52 待投递去重：同 (taskId,status) 的 task-notification 已在队列
 * 待投递（pending）时直接跳过（官方去重护栏——enqueueAgentNotification 的
 * 完成通知与 TaskStop/kill 路径竞态时不再重复入队）。
 */
export function enqueuePendingNotification(command: NotificationCommand): void {
  const dedupKey = notificationDedupKey(command)
  if (dedupKey !== undefined) {
    const duplicate = commandQueue.some(
      cmd => notificationDedupKey(cmd) === dedupKey,
    )
    if (duplicate) {
      logForDebugging(
        `[messageQueue] skip duplicate pending notification (${dedupKey})`,
      )
      return
    }
  }
  const stored: QueuedCommand = {
    ...command,
    priority: command.priority ?? 'later',
  }
  if (command.ahead === true) {
    commandQueue.unshift(stored)
  } else {
    commandQueue.push(stored)
  }
  notifySubscribers()
  logOperation(
    'enqueue',
    typeof command.value === 'string' ? command.value : undefined,
  )
}

// (taskId,status) 待投递去重：从 task-notification 文本里提取键。非
// task-notification 命令或缺失标签 → undefined（不去重）。
const NOTIFICATION_TASK_KEY_RE = /<task-id>([^<]+)<\/task-id>/
const NOTIFICATION_STATUS_KEY_RE = /<status>([^<]*)<\/status>/

function notificationDedupKey(cmd: QueuedCommand): string | undefined {
  if (cmd.mode !== 'task-notification' || typeof cmd.value !== 'string') {
    return undefined
  }
  const taskId = NOTIFICATION_TASK_KEY_RE.exec(cmd.value)?.[1]
  if (taskId === undefined) {
    return undefined
  }
  const status = NOTIFICATION_STATUS_KEY_RE.exec(cmd.value)?.[1] ?? ''
  return `${taskId}\u0000${status}`
}

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

/**
 * Remove and return the highest-priority command, or undefined if empty.
 * Within the same priority level, commands are dequeued FIFO.
 *
 * An optional `filter` narrows the candidates: only commands for which the
 * predicate returns `true` are considered. Non-matching commands stay in the
 * queue untouched. This lets between-turn drains (SDK, REPL) restrict to
 * main-thread commands (`cmd.agentId === undefined`) without restructuring
 * the existing while-loop patterns.
 */
export function dequeue(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }

  // Find the first command with the highest priority (respecting filter)
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }

  if (bestIdx === -1) return undefined

  const [dequeued] = commandQueue.splice(bestIdx, 1)
  notifySubscribers()
  logOperation('dequeue')
  return dequeued
}

/**
 * Remove and return all commands from the queue.
 * Logs a dequeue operation for each command.
 */
export function dequeueAll(): QueuedCommand[] {
  if (commandQueue.length === 0) {
    return []
  }

  const commands = [...commandQueue]
  commandQueue.length = 0
  notifySubscribers()

  for (const _cmd of commands) {
    logOperation('dequeue')
  }

  return commands
}

/**
 * Return the highest-priority command without removing it, or undefined if empty.
 * Accepts an optional `filter` — only commands passing the predicate are considered.
 */
export function peek(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }
  if (bestIdx === -1) return undefined
  return commandQueue[bestIdx]
}

/**
 * Remove and return all commands matching a predicate, preserving priority order.
 * Non-matching commands stay in the queue.
 */
export function dequeueAllMatching(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const matched: QueuedCommand[] = []
  const remaining: QueuedCommand[] = []
  for (const cmd of commandQueue) {
    if (predicate(cmd)) {
      matched.push(cmd)
    } else {
      remaining.push(cmd)
    }
  }
  if (matched.length === 0) {
    return []
  }
  commandQueue.length = 0
  commandQueue.push(...remaining)
  notifySubscribers()
  for (const _cmd of matched) {
    logOperation('dequeue')
  }
  return matched
}

/**
 * Remove specific commands from the queue by reference identity.
 * Callers must pass the same object references that are in the queue
 * (e.g. from getCommandsByMaxPriority). Logs a 'remove' operation for each.
 */
export function remove(commandsToRemove: QueuedCommand[]): void {
  if (commandsToRemove.length === 0) {
    return
  }

  const before = commandQueue.length
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (commandsToRemove.includes(commandQueue[i]!)) {
      commandQueue.splice(i, 1)
    }
  }

  if (commandQueue.length !== before) {
    notifySubscribers()
  }

  for (const _cmd of commandsToRemove) {
    logOperation('remove')
  }
}

/**
 * Remove commands matching a predicate.
 * Returns the removed commands.
 */
export function removeByFilter(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const removed: QueuedCommand[] = []
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (predicate(commandQueue[i]!)) {
      removed.unshift(commandQueue.splice(i, 1)[0]!)
    }
  }

  if (removed.length > 0) {
    notifySubscribers()
    for (const _cmd of removed) {
      logOperation('remove')
    }
  }

  return removed
}

/**
 * Clear all commands from the queue.
 * Used by ESC cancellation to discard queued notifications.
 */
export function clearCommandQueue(): void {
  if (commandQueue.length === 0) {
    return
  }
  commandQueue.length = 0
  notifySubscribers()
}

/**
 * Clear all commands and reset snapshot.
 * Used for test cleanup.
 */
export function resetCommandQueue(): void {
  commandQueue.length = 0
  snapshot = Object.freeze([])
}

// ============================================================================
// Editable mode helpers
// ============================================================================

const NON_EDITABLE_MODES = new Set<PromptInputMode>([
  'task-notification',
] satisfies Permutations<Exclude<PromptInputMode, EditablePromptInputMode>>)

export function isPromptInputModeEditable(
  mode: PromptInputMode,
): mode is EditablePromptInputMode {
  return !NON_EDITABLE_MODES.has(mode)
}

/**
 * Whether this queued command can be pulled into the input buffer via UP/ESC.
 * System-generated commands (proactive ticks, scheduled tasks, plan
 * verification, channel messages) contain raw XML and must not leak into
 * the user's input.
 */
export function isQueuedCommandEditable(cmd: QueuedCommand): boolean {
  return isPromptInputModeEditable(cmd.mode) && !cmd.isMeta
}

/**
 * Whether this queued command should render in the queue preview under the
 * prompt. Superset of editable — channel messages show (so the keyboard user
 * sees what arrived) but stay non-editable (raw XML).
 *
 * CCH #50/#52 静默面：passive 通知（如主会话的 userResumeNotice）不进
 * 预览、不弹提示 —— 消息本体照常投递给模型。
 */
export function isQueuedCommandVisible(cmd: QueuedCommand): boolean {
  if (isPassiveNotification(cmd)) return false
  if (
    (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
    (cmd as Record<string, unknown>).origin !== undefined &&
    ((cmd as Record<string, unknown>).origin as Record<string, unknown>)
      ?.kind === 'channel'
  )
    return true
  return isQueuedCommandEditable(cmd)
}

/**
 * Extract text from a queued command value.
 * For strings, returns the string.
 * For ContentBlockParam[], extracts text from text blocks.
 */
function extractTextFromValue(value: string | ContentBlockParam[]): string {
  return typeof value === 'string' ? value : extractTextContent(value, '\n')
}

/**
 * Extract images from ContentBlockParam[] and convert to PastedContent format.
 * Returns empty array for string values or if no images found.
 */
function extractImagesFromValue(
  value: string | ContentBlockParam[],
  startId: number,
): PastedContent[] {
  if (typeof value === 'string') {
    return []
  }

  const images: PastedContent[] = []
  let imageIndex = 0
  for (const block of value) {
    if (block.type === 'image' && block.source.type === 'base64') {
      images.push({
        id: startId + imageIndex,
        type: 'image',
        content: block.source.data,
        mediaType: block.source.media_type,
        filename: `image${imageIndex + 1}`,
      })
      imageIndex++
    }
  }
  return images
}

export type PopAllEditableResult = {
  text: string
  cursorOffset: number
  images: PastedContent[]
}

/**
 * Pop all editable commands and combine them with current input for editing.
 * Notification modes (task-notification) are left in the queue
 * to be auto-processed later.
 * Returns object with combined text, cursor offset, and images to restore.
 * Returns undefined if no editable commands in queue.
 */
export function popAllEditable(
  currentInput: string,
  currentCursorOffset: number,
): PopAllEditableResult | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }

  const { editable = [], nonEditable = [] } = objectGroupBy(
    [...commandQueue],
    cmd => (isQueuedCommandEditable(cmd) ? 'editable' : 'nonEditable'),
  )

  if (editable.length === 0) {
    return undefined
  }

  // Extract text from queued commands (handles both strings and ContentBlockParam[])
  const queuedTexts = editable.map(cmd => extractTextFromValue(cmd.value))
  const newInput = [...queuedTexts, currentInput].filter(Boolean).join('\n')

  // Calculate cursor offset: length of joined queued commands + 1 + current cursor offset
  const cursorOffset = queuedTexts.join('\n').length + 1 + currentCursorOffset

  // Extract images from queued commands
  const images: PastedContent[] = []
  let nextImageId = Date.now() // Use timestamp as base for unique IDs
  for (const cmd of editable) {
    // handlePromptSubmit queues images in pastedContents (value is a string).
    // Preserve the original PastedContent id so imageStore lookups still work.
    if (cmd.pastedContents) {
      for (const content of Object.values(cmd.pastedContents)) {
        if (content.type === 'image') {
          images.push(content)
        }
      }
    }
    // Bridge/remote commands may embed images directly in ContentBlockParam[].
    const cmdImages = extractImagesFromValue(cmd.value, nextImageId)
    images.push(...cmdImages)
    nextImageId += cmdImages.length
  }

  for (const command of editable) {
    logOperation(
      'popAll',
      typeof command.value === 'string' ? command.value : undefined,
    )
  }

  // Replace queue contents with only the non-editable commands
  commandQueue.length = 0
  commandQueue.push(...nonEditable)
  notifySubscribers()

  return { text: newInput, cursorOffset, images }
}

/**
 * Get commands at or above a given priority level without removing them.
 * Useful for mid-chain draining where only urgent items should be processed.
 *
 * Priority order: 'now' (0) > 'next' (1) > 'later' (2).
 * Passing 'now' returns only now-priority commands; 'later' returns everything.
 */
export function getCommandsByMaxPriority(
  maxPriority: QueuePriority,
): QueuedCommand[] {
  const threshold = PRIORITY_ORDER[maxPriority]
  return commandQueue.filter(
    cmd => PRIORITY_ORDER[cmd.priority ?? 'next'] <= threshold,
  )
}

/**
 * Returns true if the command is a slash command that should be routed through
 * processSlashCommand rather than sent to the model as text.
 *
 * Commands with `skipSlashCommands` are usually treated as plain text, except
 * Remote Control bridge messages (`bridgeOrigin`) that are re-validated later
 * through isBridgeSafeCommand().
 */
export function isSlashCommand(cmd: QueuedCommand): boolean {
  return (
    typeof cmd.value === 'string' &&
    cmd.value.trim().startsWith('/') &&
    (!cmd.skipSlashCommands || cmd.bridgeOrigin === true)
  )
}
