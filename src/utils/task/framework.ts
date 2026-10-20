import type { AppState } from '../../state/AppState.js'
import {
  isTerminalTaskStatus,
  type TaskStatus,
  type TaskType,
} from '../../Task.js'
import type { TaskState } from '../../tasks/types.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  getAllTaskHandleRecords,
  recordTaskHeartbeats,
  type TaskHandleRecord,
} from '../../services/taskRegistry/taskRegistry.js'
import { escapeXml } from '../xml.js'
import { enqueuePendingNotification } from '../messageQueueManager.js'
import { enqueueSdkEvent } from '../sdkEventQueue.js'
import { getTaskOutputDelta } from './diskOutput.js'

// Standard polling interval for all tasks
export const POLL_INTERVAL_MS = 1000

// Duration to display killed tasks before eviction
export const STOPPED_DISPLAY_MS = 3_000

// Grace period for terminal local_agent tasks in the coordinator panel
export const PANEL_GRACE_MS = 30_000

// Attachment type for task status updates
export type TaskAttachment = {
  type: 'task_status'
  taskId: string
  toolUseId?: string
  taskType: TaskType
  status: TaskStatus
  description: string
  deltaSummary: string | null // New output since last attachment
}

type SetAppState = (updater: (prev: AppState) => AppState) => void

/**
 * Update a task's state in AppState.
 * Helper function for task implementations.
 * Generic to allow type-safe updates for specific task types.
 */
export function updateTaskState<T extends TaskState>(
  taskId: string,
  setAppState: SetAppState,
  updater: (task: T) => T,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId] as T | undefined
    if (!task) {
      // Official branch (0001:8423 task-not-in-reason=task-not-in-registry):
      // a status/notification write racing an already-evicted task must be
      // visible somewhere — silent swallow hid kill/complete races.
      logForDebugging(
        `task-not-in-registry: updateTaskState(${taskId}) hit an evicted/unknown task`,
      )
      return prev
    }
    const updated = updater(task)
    if (updated === task) {
      // Updater returned the same reference (early-return no-op). Skip the
      // spread so s.tasks subscribers don't re-render on unchanged state.
      return prev
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: updated,
      },
    }
  })
}

/**
 * Register a new task in AppState.
 */
export function registerTask(task: TaskState, setAppState: SetAppState): void {
  let isReplacement = false
  setAppState(prev => {
    const existing = prev.tasks[task.id]
    isReplacement = existing !== undefined
    // Carry forward UI-held state on re-register (resumeAgentBackground
    // replaces the task; user's retain shouldn't reset). startTime keeps
    // the panel sort stable; messages + diskLoaded preserve the viewed
    // transcript across the replace (the user's just-appended prompt lives
    // in messages and isn't on disk yet).
    const merged =
      existing && 'retain' in existing
        ? {
            ...task,
            retain: existing.retain,
            startTime: existing.startTime,
            messages: existing.messages,
            diskLoaded: existing.diskLoaded,
            pendingMessages: existing.pendingMessages,
          }
        : task
    return { ...prev, tasks: { ...prev.tasks, [task.id]: merged } }
  })

  // Replacement (resume) — not a new start. Skip to avoid double-emit.
  if (isReplacement) return

  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: task.id,
    tool_use_id: task.toolUseId,
    description: task.description,
    task_type: task.type,
    workflow_name:
      'workflowName' in task
        ? (task.workflowName as string | undefined)
        : undefined,
    prompt: 'prompt' in task ? (task.prompt as string) : undefined,
  })
}

/**
 * Eagerly evict a terminal task from AppState.
 * The task must be in a terminal state (completed/failed/killed) with notified=true.
 * This allows memory to be freed without waiting for the next query loop iteration.
 * The lazy GC in generateTaskAttachments() remains as a safety net.
 */
export function evictTerminalTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId]
    if (!task) return prev
    if (!isTerminalTaskStatus(task.status)) return prev
    if (!task.notified) return prev
    // Panel grace period — blocks eviction until deadline passes.
    // 'retain' in task narrows to LocalAgentTaskState (the only type with
    // that field); evictAfter is optional so 'evictAfter' in task would
    // miss tasks that haven't had it set yet.
    if ('retain' in task && (task.evictAfter ?? Infinity) > Date.now()) {
      return prev
    }
    const { [taskId]: _, ...remainingTasks } = prev.tasks
    return { ...prev, tasks: remainingTasks }
  })
}

/**
 * Get all running tasks.
 */
export function getRunningTasks(state: AppState): TaskState[] {
  const tasks = state.tasks ?? {}
  return Object.values(tasks).filter(task => task.status === 'running')
}

/**
 * Generate attachments for tasks with new output or status changes.
 * Called by the framework to create push notifications.
 */
export async function generateTaskAttachments(state: AppState): Promise<{
  attachments: TaskAttachment[]
  // Only the offset patch — NOT the full task. The task may transition to
  // completed during getTaskOutputDelta's async disk read, and spreading the
  // full stale snapshot would clobber that transition (zombifying the task).
  updatedTaskOffsets: Record<string, number>
  evictedTaskIds: string[]
}> {
  const attachments: TaskAttachment[] = []
  const updatedTaskOffsets: Record<string, number> = {}
  const evictedTaskIds: string[] = []
  const tasks = state.tasks ?? {}

  for (const taskState of Object.values(tasks)) {
    if (taskState.notified) {
      switch (taskState.status) {
        case 'completed':
        case 'failed':
        case 'killed':
          // Evict terminal tasks — they've been consumed and can be GC'd
          evictedTaskIds.push(taskState.id)
          continue
        case 'pending':
          // Keep in map — hasn't run yet, but parent already knows about it
          continue
        case 'running':
          // Fall through to running logic below
          break
      }
    }

    if (taskState.status === 'running') {
      const delta = await getTaskOutputDelta(
        taskState.id,
        taskState.outputOffset,
      )
      if (delta.content) {
        updatedTaskOffsets[taskState.id] = delta.newOffset
      }
    }

    // Completed tasks are NOT notified here — each task type handles its own
    // completion notification via enqueuePendingNotification(). Generating
    // attachments here would race with those per-type callbacks, causing
    // dual delivery (one inline attachment + one separate API turn).
  }

  // CCH 审查修复（回归官方 :8420/:8428）：completed/failed/killed 死讯
  // **不再经附件面广播** —— 官方语义里 completed 结果由 tool_result 直接
  // 送达，未投死讯的唯一补投咽喉是 deliverOnResume（$M 单点形态，挂
  // resumeAgent 显式复活点）；进程死亡 = 表清空，零启动回放。本附件面只
  // 承担 still-running 视图注入与输出增量/逐出记账。

  // CCH #52/#44: 子代理列表模型侧视图——每轮把中央句柄表里的 still-running
  // 快照注入给主代理（官方对齐 docs/reverse-284:
  // 0001-chunk-xrzcaagk/module-006-uncategorized.js:8781 task_status 附件
  // running 分支：`<system-reminder>` + isMeta 形态 + bash/agent 两分支
  // 逐字措辞 + 每任务一信使）。
  enqueueStillRunningReminder()

  // CCH #38: 输出增量 → 中央句柄心跳（reaper"超时无增量"的增量来源）。
  recordTaskHeartbeats(Object.keys(updatedTaskOffsets))

  return { attachments, updatedTaskOffsets, evictedTaskIds }
}

// ── CCH #52/#44: still-running 快照注入 ─────────────────────────────────
//
// 数据源：中央句柄表（taskRegistry.getAllTaskHandleRecords 过滤
// status==='running'），与 AppState.tasks 视图解耦——TaskStop 后被逐出、
// 或 compaction 后 spawn 消息丢失的 agent 依然可见，防模型重复 spawn。
//
// 防自激：reminder 走命令队列（mid-turn 'next' 优先级，isMeta 隐藏于
// transcript）；若内容与上一条完全一致则跳过。没有这一步，"空闲队列
// 唤醒新 turn → turn 内 attachments 再次入队 → 再唤醒"会自持成环。
//
// staleness 复位（R1-high）：running 集清空时必须重置去重位——否则
// completed → revive（unpark 复活路）的同名串会被旧串完全匹配吞掉，
// 复活后的 running 视图对模型静默丢失。复位只发生在"已经没有 running"
// 的时刻，此刻无队列自激面（无注入→无唤醒）。

const STILL_RUNNING_PRIORITY = 'next' as const

let lastStillRunningReminder: string | undefined

/** 测试缝：清 still-running 去重位。 */
export function _resetStillRunningReminderForTest(): void {
  lastStillRunningReminder = undefined
}

/**
 * 单个 running 句柄的官方逐字 still-running 信使行（0001-chunk-xrzcaagk/
 * module-006-uncategorized.js:8781 task_status running 分支，原文分两个
 * 形态；每个 task_status 附件产出一整条 `sl(...)` 信使 = 官方每任务一条
 * 信使，不在跨任务间合并）：
 *
 * - local_bash 分支（shell 面）：`Background shell\|monitor ${id} ("${desc}")
 *   is still running.` + `Do not start it again; to restart it, stop it with
 *   TaskStop first.`（原文 `${ug}`=TaskStop 工具名）+ 可选
 *   `You can read its output at ${path}.`
 * - agent 分支（其余）：`Background agent "${desc}" (${id}) is still
 *   running.` + `Do NOT spawn a duplicate. You will be notified when it
 *   completes. ` + 尾句按有无输出文件二分（列 partial output + SendMessage
 *   催报 / 仅 SendMessage 催报）。agent 分支原文**没有** TaskStop 续句——
 *   上一版把 bash 分支措辞套到 agent 上是错体。
 */
function stillRunningReminderForRecord(record: TaskHandleRecord): string {
  const desc = escapeXml(record.description)
  if (record.type === 'local_bash') {
    // 原文 bash 分支尾句按有无输出文件二分（有 → 读输出文件句）。
    const output = record.outputFile
      ? ` You can read its output at ${record.outputFile}.`
      : ''
    // 原文 `${U} ${e.taskId} ("${W}") is still running${V}.`：bash 分支
    // id 在前、括引描述在后；CCH TaskHandleRecord 无 shell.kind——monitor
    // 变体（"Background monitor"）留待 monitor 句柄接线时启用。
    return (
      `Background shell ${record.id} ("${desc}") is still running. ` +
      `Do not start it again; to restart it, stop it with TaskStop first.` +
      output
    )
  }
  // agent 分支尾句按有无输出文件二分（原文两选一）。
  const tail = record.outputFile
    ? `You can read partial output at ${record.outputFile} or send it a message with SendMessage.`
    : `Send it a message with SendMessage if you need a progress report before then.`
  return (
    `Background agent "${desc}" (${record.id}) is still running. ` +
    `Do NOT spawn a duplicate. You will be notified when it completes. ${tail}`
  )
}

/**
 * 每任务一条的 still-running 信使（官方形制：每 task_status 附件一条信使
 * `return[Re({content:sl(...),isMeta:!0})]`，sl() 即 <system-reminder>
 * 包裹）。跨任务合并单信使体是上一版偏差——按官方拆分（每任务一条独立
 * reminder 信使，官方每任务一信使口径）。
 */
export function buildStillRunningReminders(): string[] {
  const running = getAllTaskHandleRecords().filter(
    record => record.status === 'running',
  )
  // 官方遍历序（Object.values）→ 保持注册表插入序，快照随集合变化可重现。
  return running.map(
    record =>
      `<system-reminder>${stillRunningReminderForRecord(record)}</system-reminder>`,
  )
}

/**
 * 把 still-running 快照注入命令队列（agent_registry_snapshot 附件面）。
 * 官方形制：每任务一条信使（8781 task_status 附件每附件一信使），running
 * 快照整体作为去重单元（内容与上一条完全一致则跳过，防队列自激；集合
 * 变化（agent 完成/复活/新 spawn）时按最新名单逐任务重新入队；running 集
 * 清空时复位去重位（completed → revive 同名串不再被旧去重位吞掉）。
 */
export function enqueueStillRunningReminder(): boolean {
  const reminders = buildStillRunningReminders()
  if (reminders.length === 0) {
    // R1-high staleness 复位：无 running 记录时旧快照串已成死面，留着只会
    // 吞掉复活后同名快照。复位（无注入 → 无唤醒 → 无自激环）。
    lastStillRunningReminder = undefined
    return false
  }
  const snapshotKey = reminders.join('\n')
  if (snapshotKey === lastStillRunningReminder) {
    return false
  }
  lastStillRunningReminder = snapshotKey
  for (const reminder of reminders) {
    enqueuePendingNotification({
      value: reminder,
      mode: 'task-notification',
      priority: STILL_RUNNING_PRIORITY,
      isMeta: true,
      // CCH 审查修复（CRITICAL 僵尸唤醒）：官方 still-running 是 turn 内
      // task_status 附件（0001-chunk-xrzcaagk/module-006-uncategorized.js
      // :8781 `Oi([Re({content:…,isMeta:!0})])`），不是唤醒 query 轮的
      // user-intent 队列命令 —— 官方 so()（:9228
      // `g.some(Ro=>…&&Ro.passive!==!0)`）把 passive 排除出唤醒判定。
      // 缺 passive 的入队让 hasUserIntentCommandsInQueue 把 still-running
      // 误判为用户意图，空闲队列被唤醒成无谓新轮（自激温床）。
      passive: true,
    })
  }
  return true
}

/**
 * Apply the outputOffset patches and evictions from generateTaskAttachments.
 * Merges patches against FRESH prev.tasks (not the stale pre-await snapshot),
 * so concurrent status transitions aren't clobbered.
 */
export function applyTaskOffsetsAndEvictions(
  setAppState: SetAppState,
  updatedTaskOffsets: Record<string, number>,
  evictedTaskIds: string[],
): void {
  const offsetIds = Object.keys(updatedTaskOffsets)
  if (offsetIds.length === 0 && evictedTaskIds.length === 0) {
    return
  }
  setAppState(prev => {
    let changed = false
    const newTasks = { ...prev.tasks }
    for (const id of offsetIds) {
      const fresh = newTasks[id]
      // Re-check status on fresh state — task may have completed during the
      // await. If it's no longer running, the offset update is moot.
      if (fresh?.status === 'running') {
        newTasks[id] = { ...fresh, outputOffset: updatedTaskOffsets[id]! }
        changed = true
      }
    }
    for (const id of evictedTaskIds) {
      const fresh = newTasks[id]
      // Re-check terminal+notified on fresh state (TOCTOU: resume may have
      // replaced the task during the generateTaskAttachments await)
      if (!fresh || !isTerminalTaskStatus(fresh.status) || !fresh.notified) {
        continue
      }
      if ('retain' in fresh && (fresh.evictAfter ?? Infinity) > Date.now()) {
        continue
      }
      delete newTasks[id]
      changed = true
    }
    return changed ? { ...prev, tasks: newTasks } : prev
  })
}
