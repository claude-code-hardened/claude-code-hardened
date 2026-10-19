import {
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
} from 'src/constants/xml.js'

/**
 * CCH #52/#46: 官方复活通知（userResumeNotice）。
 *
 * 官方真源 docs/reverse-284/0001-chunk-xrzcaagk/module-006-uncategorized.js:2295
 * `Eyo`：复活落点向父会话队列一条 task-notification 制式通知——
 *   {value: Xi({taskId, summary, body}), mode:'task-notification',
 *    skipAttachments:true, priority:'next'(T3e="next"), taskId,
 *    agentId:r(=to,目标会话), userResumeNotice:true,
 *    ...target===current-main && {passive:true}}
 *
 * CCH 落法：resumeAgentBackground 是全部复活路（REPL transcript 视图复活、
 * SendMessage 停滞 agent 自动复活、bridge）的唯一咽喉，通知在该单点发射。
 *
 * R1-low（official `agentId:r` 补齐；Q2 W1.5 复核）：NotificationCommandOptions
 * 现已具备官方 `agentId` 信封字段（0001/module-006:2295 `Eyo` 同型），但
 * 本通知**不**走信封字段：CCH 队列消费面（queueProcessor/query.ts）以
 * `agentId === undefined` 判主线程，本会话内自投的通知若携带信封 agentId
 * 会永远无人投递（F4 顾虑复核为真实）。故保 payload `agent-id` tag 行 +
 * 本注释声明官方差异（官方信封字段是跨会话路由面；CCH 目标恒为发布方
 * 所在会话，即 getSessionId()）。
 *
 * passive 在 CCH 里无法从队列信封结构化地传到渲染面，随信使文本携带
 * （`<task-notification passive="true">` 属性），由
 * UserAgentNotificationMessage 判定静默不弹提示；队列信封仍带 passive:true
 * （isQueuedCommandVisible 静默预览面 + useQueueProcessor 不计 user
 * intent，官方 so() 口径）。
 */

export const USER_RESUME_NOTICE_PRIORITY = 'next' as const

/** 官方命令形状 `agentId:r`（目标）在 payload 里的字段名。 */
export const USER_RESUME_NOTICE_AGENT_ID_TAG = 'agent-id'

export const USER_RESUME_NOTICE_BODY =
  '\n<note>The user resumed this agent from its transcript view; it is running again. Do not treat its work as cancelled or relaunch it; its result arrives in a later task-notification for this task-id.</note>'

// CCH #46 模块级去重：同 taskId 本进程只通知一次（官方 xge 匹配器 +
// Ast 队列摘除的等价落法——复活可重复触发，通知不可重复入队）。
const userResumeNotifiedTaskIds = new Set<string>()

/** 测试缝：清复活通知去重位（不动 sink；见
 * _setUserResumeNoticeSinkForTest）。 */
export function _resetUserResumeNoticesForTest(): void {
  userResumeNotifiedTaskIds.clear()
}

/**
 * 复活通知信封（官方 Eyo 命令形状的 CCH 子集；值经 messageQueueManager 的
 * NotificationCommand 信封入库）。
 */
export type UserResumeNoticeCommand = {
  value: string
  mode: 'task-notification'
  priority: 'next'
  skipAttachments: true
  userResumeNotice: true
  passive: true
  taskId: string
}

/**
 * 发射缝：测试注入替代真实队列（真实 messageQueueManager 的注册在全量
 * 并发跑里会被其他 suite 的 process-global mock 特化——注入点绕开注册表
 * 竞态，使命令形状/去重语义的断言确定性）。缺省 undefined → 走真实队列。
 */
type ResumeNoticeSink = (command: UserResumeNoticeCommand) => void
let userResumeNoticeSink: ResumeNoticeSink | undefined

export function _setUserResumeNoticeSinkForTest(
  sink: ResumeNoticeSink | undefined,
): void {
  userResumeNoticeSink = sink
}

/** 官方 xge 等价判定：该 taskId 是否已发过复活通知。 */
export function hasUserResumeNotice(taskId: string): boolean {
  return userResumeNotifiedTaskIds.has(taskId)
}

/**
 * 构造复活通知 payload（R1-low：带官方 agentId 字段 = 目标会话
 * `agentId:r`；taskId = 被复活的 agent）。官方命令形状里 agentId 属信封
 * 路由面（CCH 信封不带，见文件头注释），这里随值携带以保证字段在场。
 */
export function buildUserResumeNoticeValue(
  agentId: string,
  description: string,
  toSessionId: string,
): string {
  return `<${TASK_NOTIFICATION_TAG} passive="true">
<${TASK_ID_TAG}>${agentId}</${TASK_ID_TAG}>
<${USER_RESUME_NOTICE_AGENT_ID_TAG}>${toSessionId}</${USER_RESUME_NOTICE_AGENT_ID_TAG}>
<${SUMMARY_TAG}>The agent "${description}" was resumed by the user</${SUMMARY_TAG}>${USER_RESUME_NOTICE_BODY}
</${TASK_NOTIFICATION_TAG}>`
}

/**
 * 复活成功后向父会话队列发射官方制式复活通知。同 taskId 已通知过则
 * no-op（返回 false）；返回 true 表示本次已入队。
 *
 * R1-low：payload 携带官方 `agentId:r`（目标会话）。CCH 复活路全部进程内
 * 自投（发布方 = 主会话），目标取 getSessionId()；bootstrap/state 走懒
 * import（与本文件 enqueue 懒加载同因——resumeAgent 的 import 链在测试里
 * 已贴着超时边缘）。
 *
 * messageQueueManager 懒加载：resumeAgent 的 import 链在测试里已贴着
 * 超时边缘，把队列模块（heavy chain）推迟到真正发通知的时刻。
 */
export async function publishUserResumeNotice(
  agentId: string,
  description: string,
): Promise<boolean> {
  if (userResumeNotifiedTaskIds.has(agentId)) {
    return false
  }
  const { getSessionId } = await import('src/bootstrap/state.js')
  userResumeNotifiedTaskIds.add(agentId)
  const command: UserResumeNoticeCommand = {
    value: buildUserResumeNoticeValue(agentId, description, getSessionId()),
    mode: 'task-notification',
    priority: USER_RESUME_NOTICE_PRIORITY,
    // 官方复活通知命令形状（Eyo）：skipAttachments + userResumeNotice +
    // passive（目标是本会话主线程，CCH 复活路全部在本会话内）。
    skipAttachments: true,
    userResumeNotice: true,
    passive: true,
    taskId: agentId,
  }
  if (userResumeNoticeSink) {
    userResumeNoticeSink(command)
    return true
  }
  const { enqueuePendingNotification } = await import(
    'src/utils/messageQueueManager.js'
  )
  enqueuePendingNotification(command)
  return true
}
