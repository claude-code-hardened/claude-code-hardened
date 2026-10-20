/**
 * 中央任务句柄注册表（CCH #38）— 官方忠实还原（docs/reverse-284）：
 *
 * 官方本体是**进程内属性、无磁盘快照、无启动广播**：
 *  - 0001-chunk-xrzcaagk/module-006-uncategorized.js:8420
 *    `g.taskRegistry=n` —— 句柄表只挂 session 对象，进程即生命周期；
 *  - :8428 `$M`（resume/kill 咽喉点）只对 `!h.notified` 的句柄补投一次
 *    （读 `h.result` 投正文），补投面只属"活进程内的真实未投"，清位后
 *    同函数内立即完成投递（无悬置窗口）；:8423 parked 静默面
 *    `quietlyParked===!0?{...s,quietlyParked:!1}` 不碰 status。
 * - 渲染面 0002-chunk-zrkp23rq/module-005-uncategorized.js:3417 起（`uV`）：
 *   task handle 按 type 渲染，字段 status/notified/quietlyParked，
 *   completed 且 notified=false 显示 ", unread"；通知只是视图 ——
 *   0001:1919/2116/2186 的 task-notification 队列 origin 语义，句柄表本体。
 *
 * CCH 审查修复 Round 由"落盘增强 + TTL/游标/CAS 加固"改为**回归官方**：
 * 磁盘快照层（$CLAUDE_CONFIG_DIR/tasks/<id>.state.json + hydrate 启动回放）
 * 是 CCH #38 曾引入的扩展，实测无任何跨进程消费者（ps/daemon/bridge/TaskList
 * 均不读平铺 .state.json，唯一读写方是本模块自身），却是本块全部
 * CRITICAL/HIGH 缺陷的根因（陈年通知回放 / ~598 僵尸 running /
 * 跨进程 last-write-wins / 快照目录只增不减 ~2947 文件 / hydrate O(N) 阻塞 /
 * .tmp-* 残留）。整体删除即整类消除，语义回官方：进程死亡 = 句柄表随
 * session 消亡，不做任何重启回放（官方无启动广播）；本模块现为**零磁盘
 * 读写**（存量残骸文件的归档由主线程另行处理，不在代码层挂钩）。
 *
 * CCH 与官方的接线差异（既有收敛 + 本轮还原）：
 *  - 正常完成/失败通知由各任务自己的回调面（enqueueAgentNotification 等）
 *    沿消费边界送达，记账点置于 runAgent wrapper（notified 随投递压位）；
 *  - 未投死讯的唯一补投咽喉 = deliverOnResume（官方 $M 单点形态，挂在
 *    resumeAgent.ts 显式复活点），不做全局池扫描/通知广播/启动回放。
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

/** 一条中央句柄记录（官方渲染面字段并集的活表形态）。 */
export type TaskHandleRecord = {
  id: string
  type: TaskHandleType
  status: TaskHandleStatus
  /** 死讯是否已补投（终态句柄由 deliverOnResume 单点咽喉置 true；非官方的"横幅已读"，见 0002 渲染面的 notified）。 */
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
  /** 压置 true（终态已沿消费边界送达：正常完成投递点/kill 静默路径，不欠死讯）。 */
  notified?: boolean
  /** 官方 parked 语义：静默完成挂表。 */
  quietlyParked?: boolean
  /**
   * CCH #52/#46 复活位（0001-chunk-xrzcaagk/module-006-uncategorized.js
   * :8428 `$M` resume 落点原文：`g.quietlyParked===!0 →
   * n.update(e,(U)=>({...U,notified:!1,quietlyParked:!1}))`）。
   * 收敛（Q2 复核原文 + CCH 审查修复）：**仅**既有记录
   * quietlyParked===true 时清 parked 位、**不动 status**——上一版顺带重开
   * 终态句柄是超宽面（$M 复活通知路从不改 status）。resume 需要把句柄
   * 重开为 running 的面另走 reopenRunning 显式路径。
   * 官方 $M :8428 清位后**同函数内立即**重读句柄、对 !h.notified 投正文
   * （无悬置窗口）；CCH 生产面暂无该咽喉点接线，若按原文双清 notified，
   * 终态句柄会以 "notified=false + status 不变" 落回死讯补投面，被当作
   * 从未送达的死讯重新投递 —— 故终态句柄 unpark 不同步清 notified，把
   * "清位后立即完成投递"留给将来真实接线方在投递完成前显式置位。
   */
  unpark?: boolean
  /**
   * resume 重开显式路径（CCH 接线面，非官方 $M）：把已冻结的终态句柄重开
   * 为 input.status（非终态时）——终态冻结防的是迟到写诈尸，不拦
   * 用户/上游发起的真实复活；与官方 $M 的静默清停车位（unpark）分开。
   */
  reopenRunning?: boolean
  /** 测试/接线点可对齐 AppState 的 startTime。 */
  startedAt?: number
  /** 测试用时钟缝。 */
  updatedAt?: number
}

export type UndeliveredTerminalTask = {
  id: string
  type: TaskHandleType
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

/**
 * CCH 审查修复 Round 的磁盘退役说明：前一版的磁盘快照层（$CLAUDE_CONFIG_DIR/
 * tasks/<id>.state.json 落盘 + hydrate 启动回放 + TTL/游标/CAS/收割加固 +
 * 遗留残骸 GC）已**整体删除**——官方 2.8.4 全 chunk 无任何落盘引用，句柄表
 * 纯进程内（:8420）。存量残骸文件（历史版本的 ~2947 个 .state.json / .tmp-*，
 * 含 ~598 条僵尸 running）的归档/清理由主线程另行处理，本模块对磁盘零读写，
 * 不接 GC 挂点。
 */

/**
 * resume 咽喉点单点补投（官方 :8428 `$M` 的 CCH 还原形态）：
 *
 * ```
 * function $M(e,n,r="user",s){
 *   let g=n.get(e); if(...g.quietlyParked===!0) n.update(e,U=>({...U,notified:!1,quietlyParked:!1}));
 *   let h=n.get(e); if(...h.notified) IC(...);
 *   if(...!h.notified){ let U=h.result,...; $ot({taskId:e,...,status:"killed",killedBy:r,...}) }
 * }
 * ```
 * 官方 `$M` 只作用于传入的单个 taskId：清停车位后按 `notified` 判断，
 * 未通知则把 result 正文单点投递，**无目录扫描、无全局补投、无跨会话广播**。
 *
 * CCH 对应落法：显式 resume 接线点（packages/builtin-tools/.../AgentTool/
 * resumeAgent.ts）在重开句柄前调用本函数；仅当该 taskId 是本进程活表内
 * `!notified` 的终态句柄时取走（置 notified=true）并返回尸讯记录（description/
 * outputFile/status 随取），由调用方单点投递。上一进程的死讯已随进程消亡，
 * 不在补投面（进程死亡 = 表清空，零回放）。
 */
export function deliverOnResume(taskId: string): TaskHandleRecord | undefined {
  const record = handles.get(taskId)
  if (
    record === undefined ||
    !isTerminalHandleStatus(record.status) ||
    record.notified
  ) {
    return undefined
  }
  record.notified = true
  return record
}

/**
 * 中央句柄表 upsert：spawn 建表 + 每次 status 迁移/标志位变化改写（纯内存，
 * 官方 :8420 形态）。已终态句柄不接受非终态回迁（迟到写不能诈尸）；例外是
 * input.reopenRunning?:true 的 resume 显式重开路径（非官方 $M 语义，见
 * TaskHandleInput.unpark/reopenRunning 的分工注释）。
 */
export function recordTaskHandle(input: TaskHandleInput): TaskHandleRecord {
  const now = input.updatedAt ?? Date.now()
  const existing = handles.get(input.id)
  const prevTerminal =
    existing !== undefined && isTerminalHandleStatus(existing.status)
  const nextTerminal = isTerminalHandleStatus(input.status)
  // resume 显式重开（Q2 收敛：与官方 $M unpark 分开——重开 running 的面
  // 只走本路径，unpark 仅清停车位）。
  const allowReopen =
    input.reopenRunning === true && existing !== undefined && !nextTerminal
  // 官方 $M（:8428）原文：`g.quietlyParked===!0 → {notified:!1,
  // quietlyParked:!1}` —— 仅 parked===true 时清位；未挂表的句柄不动。
  // CCH 修复（unpark 死讯环）：终态句柄 unpark 后 status 不变，若同步清
  // notified，下一轮 consume 会把它当"从未送达的死讯"重投 —— 官方 $M
  // 清位后同函数内立即完成投递，无此悬置窗口；CCH 接线面缺位前，终态
  // 句柄保留 notified，parked 位照清。
  const unparkParked = input.unpark === true && existing?.quietlyParked === true
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
    // parked/updatedAt 等元数据位。唯一例外是 resume 接线面的显式
    // reopenRunning：真实复活把句柄重开为非终态（并清 parked/notified）。
    const status =
      prevTerminal && existing.status !== input.status && !allowReopen
        ? existing.status
        : input.status
    const reopened = allowReopen && existing.status !== status
    record = {
      ...existing,
      type: input.type,
      status,
      description: input.description ?? existing.description,
      outputFile: input.outputFile ?? existing.outputFile,
      // 复活重开：上一轮的终态成因不带走（exitKind 只见证最近一次终态）。
      exitKind: reopened ? undefined : (input.exitKind ?? existing.exitKind),
      // not 传即保留：补投位（consume）与接线点的已送达位互不回退。
      // 官方 $M notice-face：复活需重置 notified（新生命周期的死讯/补投
      // 位归零）；unpark 同句式（{notified:!1, quietlyParked:!1}）→ 仅
      // parked===true 时双清，未挂表的句柄 notified 保留既有值。
      notified: reopened
        ? (input.notified ?? false)
        : unparkParked
          ? isTerminalHandleStatus(status)
            ? // CCH 修复（unpark 死讯环）：终态句柄清位后不立即投递会成为
              // 假死讯 —— 保留已投位（见 TaskHandleInput.unpark 注）。
              true
            : false
          : (input.notified ?? existing.notified),
      // 官方 $M：仅 quietlyParked===true 时清 parked（不挂表不动）。
      // resume 重开（reopened）同属新生命周期：上一轮 parked 位不带入
      // （否则重开的 running 句柄仍挂 quietlyParked，渲染面/消费面按
      // 已处理吞掉复活视图）。
      quietlyParked: reopened
        ? (input.quietlyParked ?? false)
        : unparkParked
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
 * 增量心跳：运行中句柄的 updatedAt 前推（输出增量/进度），内存位。
 * 未知句柄或非运行句柄 no-op（不 upsert）。
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
 * reaper：running 且 updatedAt 超 maxSilenceMs 无增量 → 疑似死亡名单。
 * 不改 status（疑似≠实锤），裁决权在调用方；名单同时挂 diagnostics
 * （lastReap）。
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
 * heapdump Diagnostics JSON 的 tasks 段。只读观察面（undelivered 走 peek
 * 不置位）；投递面不在诊断——升级后唯一投递咽喉是 deliverOnResume（官方
 * $M 形态的单点补投）。
 */
export function getTaskRegistryDiagnostics(
  _consumeUndelivered = false,
): TaskRegistryDiagnostics {
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
    undelivered: peekUndeliveredTerminalTasks(),
    ...(lastReap !== undefined ? { lastReap } : {}),
  }
}

/** 只读未投面（不置位），给 diagnostics 与测试观察用；投递走 deliverOnResume 单点咽喉。 */
export function peekUndeliveredTerminalTasks(): UndeliveredTerminalTask[] {
  const undelivered: UndeliveredTerminalTask[] = []
  for (const record of handles.values()) {
    if (!isTerminalHandleStatus(record.status) || record.notified) {
      continue
    }
    undelivered.push({
      id: record.id,
      type: record.type,
      status: record.status,
      ...(record.exitKind !== undefined ? { exitKind: record.exitKind } : {}),
    })
  }
  return undelivered
}

/** 测试助手：清内存表 + 挂表 reaper 结果（模拟进程重启——回官方：表随 session 消亡）。 */
export function _resetTaskRegistryForTest(): Promise<void> {
  handles.clear()
  lastReap = undefined
  return Promise.resolve()
}
