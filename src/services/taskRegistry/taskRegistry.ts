import { mkdir, rename, writeFile } from 'fs/promises'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

/**
 * 中央任务句柄注册表（CCH #38）— 官方对齐（docs/reverse-284）：
 *
 * 官方渲染面 0002-chunk-zrkp23rq/module-005-uncategorized.js:3417 起
 * (`uV`)：task handle 按 type 渲染（local_bash / local_agent /
 * local_workflow / in_process_teammate / monitor_* / mcp_task / dream /
 * auto_mode_scan ...），字段 status/notified/quietlyParked；completed 且
 * notified=false 显示 ", unread"。官方 0001-chunk-xrzcaagk/
 * module-006-uncategorized.js:1919/2116/2186：task-notification 队列的
 * origin.kind === 'task-notification' 只是视图 —— **中央句柄表为本体**，
 * 通知丢了（死后才轮询到）也能从句柄表补投（"死讯补投"），句柄死亡即
 * parked 挂表、轮询可达。
 *
 * CCH 落法：AppState.tasks 是会话内 UI 视图（src/utils/task/framework.ts），
 * 本模块是独立的中央句柄表：每次 status 迁移全量落盘
 * `$CLAUDE_CONFIG_DIR/tasks/<id>.state.json`（路径模式同 server/lockfile.ts，
 * 解析函数复用 utils/envUtils.getClaudeConfigHomeDir）。目录与 TaskList
 * 工具的 `<configDir>/tasks/<listId>/`（src/utils/tasks.ts）只共用 `tasks/`
 * 根 —— listTasks 只读 `<listId>` 子目录，平铺的 `<id>.state.json` 互不干扰。
 *
 * 落盘写失败：console.debug，不抛（补投面宁可丢快照也不能打断任务收尾）。
 */

/** 官方句柄状态并集：渲染面 pending/running/completed/failed/killed/paused，任务流 error/truncated，monitor/auto-scan 的 scanning/idle。 */
export type TaskHandleStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'error'
  | 'truncated'
  | 'scanning'
  | 'idle'

/** 官方 type 全集（TaskType 是其子集；monitor_ws/mcp_task/auto_mode_scan 留待接线，标 TODO）。 */
export type TaskHandleType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'monitor_ws'
  | 'mcp_task'
  | 'dream'
  | 'auto_mode_scan'

/** 终态成因。官方 0001 chunk `tmo`/`emo`：outcome ∈ completed/failed/killed，stop 判 killed → cancelled 这路走 'stopped'。 */
export type TaskExitKind = 'completed' | 'failed' | 'killed' | 'stopped'

export function isTerminalHandleStatus(status: TaskHandleStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'killed' ||
    status === 'error' ||
    status === 'truncated'
  )
}

/** 一条中央句柄记录（官方渲染面字段并集的持久形态）。 */
export type TaskHandleRecord = {
  id: string
  type: TaskHandleType
  status: TaskHandleStatus
  /** 死讯是否已补投（终态句柄由 consumeUndeliveredTerminalTasks 置 true；非官方的"横幅已读"，见 0002 渲染面的 notified）。 */
  notified: boolean
  /** 官方 quietlyParked：completed 但静默挂表（无独立通知面）。 */
  quietlyParked?: boolean
  description: string
  outputFile?: string
  exitKind?: TaskExitKind
  startedAt: number
  updatedAt: number
}

export type TaskHandleInput = {
  id: string
  type: TaskHandleType
  status: TaskHandleStatus
  description?: string
  outputFile?: string
  /** 终态成因（非终态忽略）。 */
  exitKind?: TaskExitKind
  /** 压置 true（如 kill 静默路径，死讯已随本体送达）。 */
  notified?: boolean
  /** 官方 parked 语义：静默完成挂表。 */
  quietlyParked?: boolean
  /**
   * CCH #52/#46 官方复活位（0001-chunk-xrzcaagk/module-006-uncategorized.js
   * `$M`：resume 落点 `quietlyParked===true → {notified:false, quietlyParked:false}`）。
   * 复活路径显式传入：清除 quietlyParked，并把已冻结的终态句柄重开为
   * input.status（非终态时）——终态冻结防的是快照链迟到写诈尸，不拦
   * 用户/上游发起的真实复活。
   */
  unpark?: boolean
  /** 测试/接线点可对齐 AppState 的 startTime。 */
  startedAt?: number
  /** 测试用时钟缝。 */
  updatedAt?: number
}

export type UndeliveredTerminalTask = {
  id: string
  status: TaskHandleStatus
  exitKind?: TaskExitKind
}

export type SuspiciousTask = {
  id: string
  type: TaskHandleType
  description: string
  updatedAt: number
  /** 距上次增量的静默时长。 */
  silenceMs: number
}

export type TaskRegistryDiagnostics = {
  handles: Array<
    Pick<
      TaskHandleRecord,
      'id' | 'type' | 'status' | 'notified' | 'quietlyParked' | 'updatedAt'
    > & { description: string }
  >
  /** 本次诊断构建时取走并置 notified=true 的死讯（补投面）。 */
  undelivered: UndeliveredTerminalTask[]
  /** 最近一次 reaper 的疑似死亡名单（挂 diagnostics，裁决权在调用方）。 */
  lastReap?: {
    at: number
    maxSilenceMs: number
    suspicious: SuspiciousTask[]
  }
}

// ---------------------------------------------------------------- registry

const handles = new Map<string, TaskHandleRecord>()

let lastReap: TaskRegistryDiagnostics['lastReap']

// 快照目录：$CLAUDE_CONFIG_DIR/tasks/。TaskList 工具的列表目录挂在同一根下
// （tasks/<listId>/），平铺 .state.json 文件不进它的读取路径，互不覆盖。
function getSnapshotsDir(): string {
  return join(getClaudeConfigHomeDir(), 'tasks')
}

/** 路径安全：任务 id 全部落盘为单段文件名（语义同 utils/tasks.ts sanitizePathComponent，但不引它的重依赖图）。 */
export function sanitizeTaskHandleId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function getTaskSnapshotPath(taskId: string): string {
  return join(getSnapshotsDir(), `${sanitizeTaskHandleId(taskId)}.state.json`)
}

// 每个 handle 一条写链：串行化同一快照的异步写，防乱序回写（先 completed 后 arrived 的迟到 notified=false 补写等）。
const pendingWrites = new Map<string, Promise<void>>()

function writeSnapshot(record: TaskHandleRecord): void {
  const chain = (pendingWrites.get(record.id) ?? Promise.resolve())
    .then(async () => {
      await mkdir(getSnapshotsDir(), { recursive: true })
      // 原子写（tmp+rename）：多进程/撕裂防护——链串行化只防本进程乱序。
      const finalPath = getTaskSnapshotPath(record.id)
      const tmpPath = `${finalPath}.tmp-${randomUUID()}`
      await writeFile(tmpPath, JSON.stringify(record, null, 2), {
        mode: 0o600,
      })
      await rename(tmpPath, finalPath)
    })
    .catch((e: unknown) => {
      // 写失败不抛：快照是诊断/补投的增强面，主流程（内存表）必须继续。
      console.debug(
        `[taskRegistry] snapshot write failed for ${record.id}:`,
        e instanceof Error ? e.message : e,
      )
    })
    .finally(() => {
      if (pendingWrites.get(record.id) === chain) {
        pendingWrites.delete(record.id)
      }
    })
  pendingWrites.set(record.id, chain)
}

/**
 * 中央句柄表 upsert：spawn 建表 + 每次 status 迁移/标志位变化改写。
 * 已终态句柄不接受非终态回迁（快照链的迟到写不能诈尸）；例外是
 * input.unpark?:true 的显式复活位（官方 $M 语义，见 TaskHandleInput）。
 */
export function recordTaskHandle(input: TaskHandleInput): TaskHandleRecord {
  const now = input.updatedAt ?? Date.now()
  const existing = handles.get(input.id)
  const prevTerminal =
    existing !== undefined && isTerminalHandleStatus(existing.status)
  const nextTerminal = isTerminalHandleStatus(input.status)
  // CCH #52/#46 官方 $M 复活位：显式 unpark 清 parked 并可重开终态句柄。
  const allowReopen =
    input.unpark === true && existing !== undefined && !nextTerminal
  let record: TaskHandleRecord

  if (existing === undefined) {
    record = {
      id: input.id,
      type: input.type,
      status: input.status,
      notified: input.notified ?? false,
      description: input.description ?? '',
      outputFile: input.outputFile,
      exitKind: input.exitKind,
      quietlyParked: input.quietlyParked,
      startedAt: input.startedAt ?? now,
      updatedAt: now,
    }
  } else {
    // 终态冻结：进终态后拒绝一切 status 迁移（回迁非终态与异种终态互踩
    // 都拒绝——completed→failed 的迟到写同样是诈尸），仅放行 notified/
    // parked/updatedAt 等元数据位。唯一例外是官方 $M 复活路径的显式
    // unpark：真实复活把句柄重开为非终态（并清 parked/notified）。
    const status =
      prevTerminal && existing!.status !== input.status && !allowReopen
        ? existing!.status
        : input.status
    const reopened = allowReopen && existing!.status !== status
    record = {
      ...existing,
      type: input.type,
      status,
      description: input.description ?? existing.description,
      outputFile: input.outputFile ?? existing.outputFile,
      // 复活重开：上一轮的终态成因不带走（exitKind 只见证最近一次终态）。
      exitKind: reopened ? undefined : (input.exitKind ?? existing.exitKind),
      // not 传即保留：补投位（consume）与接线点的已送达位互不回退。
      // 官方 $M：复活需要重置 notified（新生命周期的死讯/补投位归零）。
      notified: reopened
        ? (input.notified ?? false)
        : (input.notified ?? existing.notified),
      // 官方 $M：复活落点显式清 quietlyParked。
      quietlyParked: input.unpark
        ? false
        : (input.quietlyParked ?? existing.quietlyParked),
      startedAt: existing.startedAt,
      updatedAt: Math.max(now, existing.updatedAt),
    }
  }
  if (nextTerminal && record.exitKind === undefined) {
    record.exitKind = statusToExitKind(record.status)
  }
  if (isTerminalHandleStatus(record.status) && record.quietlyParked) {
    record.notified = true
  }
  handles.set(record.id, record)

  // 全量落盘时机：status 迁移位（含既有句柄的终态补录）或补投/parked 位翻转。
  const statusChanged =
    existing === undefined || existing.status !== record.status
  const flagsChanged =
    existing !== undefined &&
    (existing.notified !== record.notified ||
      existing.quietlyParked !== record.quietlyParked)
  if (statusChanged || flagsChanged) {
    writeSnapshot(record)
  }
  return record
}

function statusToExitKind(status: TaskHandleStatus): TaskExitKind | undefined {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
    case 'error':
    case 'truncated':
      return 'failed'
    case 'killed':
      return 'killed'
    default:
      return undefined
  }
}

/**
 * 增量心跳：运行中句柄的 updatedAt 前推（输出增量/进度），内存位，不落盘
 * （避免每次输出心跳都写盘；崩溃后快照里的 updatedAt 只会偏旧 → reaper
 * 重启后更保守，不会漏报）。未知句柄或非运行句柄 no-op（不 upsert）。
 */
export function recordTaskHeartbeat(
  taskId: string,
  at: number = Date.now(),
): void {
  const record = handles.get(taskId)
  if (record === undefined || record.status !== 'running') {
    return
  }
  record.updatedAt = Math.max(record.updatedAt, at)
}

/** 批量心跳（接线点单行用：输出增量 id 列表）。 */
export function recordTaskHeartbeats(
  taskIds: readonly string[],
  at: number = Date.now(),
): void {
  for (const taskId of taskIds) {
    recordTaskHeartbeat(taskId, at)
  }
}

export function getTaskHandleRecord(
  taskId: string,
): TaskHandleRecord | undefined {
  return handles.get(taskId)
}

export function getAllTaskHandleRecords(): TaskHandleRecord[] {
  return [...handles.values()]
}

/**
 * 启动恢复（lazy，单次）：进程重启后内存表为空，快照目录里的终态死讯若不
 * hydrate 就永远无人投递（孤儿文件）；running 快照保持 running（reaper 按
 * updatedAt 判疑似）。所有读取/消费面前置调用。
 */
let hydrated = false
export function hydrateTaskRegistry(): void {
  if (hydrated) return
  hydrated = true
  let dir: string
  try {
    dir = getSnapshotsDir()
    if (!existsSync(dir)) return
  } catch {
    return
  }
  let files: string[]
  try {
    files = readdirSync(dir).filter((f: string) => f.endsWith('.state.json'))
  } catch (e: unknown) {
    console.debug(
      '[taskRegistry] hydrate scan failed:',
      e instanceof Error ? e.message : e,
    )
    return
  }
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8')
      const parsed = JSON.parse(raw) as TaskHandleRecord
      if (
        typeof parsed?.id !== 'string' ||
        typeof parsed?.type !== 'string' ||
        typeof parsed?.status !== 'string'
      ) {
        continue
      }
      // 内存表缺位才补（同进程先 spawn 的条目以内存为准）。
      hydrateHandles(parsed)
    } catch {
      // 单文件损坏跳过，不阻塞整体恢复
    }
  }
}

/** hydrate 注入：绕过 recordTaskHandle 的覆盖语义，直接补位。 */
function hydrateHandles(record: TaskHandleRecord): void {
  if (!handles.has(record.id)) {
    handles.set(record.id, record)
  }
}

/**
 * 死讯补投投递面：快照里 status 终态且 notified=false 的清单，取走即置
 * notified=true 回写。消费点点位见 generateTaskAttachments（每轮任务附件
 * 面，模型可见）与诊断构建面。
 */
export function consumeUndeliveredTerminalTasks(): UndeliveredTerminalTask[] {
  hydrateTaskRegistry()
  const undelivered: UndeliveredTerminalTask[] = []
  for (const record of handles.values()) {
    if (!isTerminalHandleStatus(record.status) || record.notified) {
      continue
    }
    record.notified = true
    undelivered.push({
      id: record.id,
      status: record.status,
      ...(record.exitKind !== undefined ? { exitKind: record.exitKind } : {}),
    })
    writeSnapshot(record)
  }
  return undelivered
}

/**
 * reaper：running 且 updatedAt 超 maxSilenceMs 无增量 → 疑似死亡名单。
 * 不改 status（疑似≠实锤），裁决权在调用方；名单同时挂 diagnostics
 * （lastReap），随 tasks 段落盘可见。
 */
export function reapSuspiciousTasks(
  maxSilenceMs: number,
  now: number = Date.now(),
): SuspiciousTask[] {
  const suspicious: SuspiciousTask[] = []
  for (const record of handles.values()) {
    if (record.status !== 'running') {
      continue
    }
    const silenceMs = Math.max(0, now - record.updatedAt)
    if (silenceMs <= maxSilenceMs) {
      continue
    }
    suspicious.push({
      id: record.id,
      type: record.type,
      description: record.description,
      updatedAt: record.updatedAt,
      silenceMs,
    })
  }
  lastReap = { at: now, maxSilenceMs, suspicious }
  return suspicious
}

/**
 * heapdump Diagnostics JSON 的 tasks 段。consumeUndelivered=true 时先走
 * 补投面（取走即置位）—— 官方"通知只是视图、句柄表轮询可达"的最小落法。
 */
export function getTaskRegistryDiagnostics(
  consumeUndelivered = false,
): TaskRegistryDiagnostics {
  // 诊断/消费面前置 hydrate：重启后快照孤儿先回表再视图/消费。
  hydrateTaskRegistry()
  const handlesView = [...handles.values()].map(record => ({
    id: record.id,
    type: record.type,
    status: record.status,
    notified: record.notified,
    ...(record.quietlyParked !== undefined
      ? { quietlyParked: record.quietlyParked }
      : {}),
    description: record.description,
    updatedAt: record.updatedAt,
  }))
  return {
    handles: handlesView,
    undelivered: consumeUndelivered
      ? consumeUndeliveredTerminalTasks()
      : peekUndeliveredTerminalTasks(),
    ...(lastReap !== undefined ? { lastReap } : {}),
  }
}

/** 只读补投面（不置位），给 diagnostics 以外的观察者。 */
export function peekUndeliveredTerminalTasks(): UndeliveredTerminalTask[] {
  const undelivered: UndeliveredTerminalTask[] = []
  for (const record of handles.values()) {
    if (!isTerminalHandleStatus(record.status) || record.notified) {
      continue
    }
    undelivered.push({
      id: record.id,
      status: record.status,
      ...(record.exitKind !== undefined ? { exitKind: record.exitKind } : {}),
    })
  }
  return undelivered
}

/** 测试助手：清内存表 + 写链 + 挂表 reaper 结果。 */
export function _resetTaskRegistryForTest(): Promise<void> {
  handles.clear()
  lastReap = undefined
  const drain = Promise.allSettled([...pendingWrites.values()])
  pendingWrites.clear()
  return drain.then(() => undefined)
}

/** 测试助手：等所有挂起快照写完（eachOther 断言前调用）。 */
export async function _flushTaskRegistrySnapshotsForTest(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites.values()])
  }
}
