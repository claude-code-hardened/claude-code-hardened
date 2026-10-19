/**
 * Tests for CCH #52/#46 官方复活通知（userResumeNotice）。
 *
 * 官方真源 docs/reverse-284/0001-chunk-xrzcaagk/module-006-uncategorized.js:2295
 * `Eyo`：{value: Xi({taskId, summary, body}), mode:'task-notification',
 * skipAttachments:true, priority:'next'(T3e), taskId, userResumeNotice:true,
 * target===main && passive:true}；模块级去重（同 taskId 只通知一次）。
 *
 * 断言走 _setUserResumeNoticeSinkForTest 注入缝——真实 messageQueueManager
 * 的模块注册在全量并发跑里会被其他 suite 的 process-global mock 特化，
 * 注入缝让命令形状/去重语义的断言与执行顺序解耦（队列本身的 ahead/passive/
 * 去重语义由 messageQueueManager.test.ts 覆盖）。
 */
import { beforeEach, describe, expect, test } from 'bun:test'

import {
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
} from 'src/constants/xml.js'
import {
  USER_RESUME_NOTICE_AGENT_ID_TAG,
  USER_RESUME_NOTICE_BODY,
  USER_RESUME_NOTICE_PRIORITY,
  _resetUserResumeNoticesForTest,
  _setUserResumeNoticeSinkForTest,
  buildUserResumeNoticeValue,
  hasUserResumeNotice,
  publishUserResumeNotice,
  type UserResumeNoticeCommand,
} from '../userResumeNotice.js'

let published: UserResumeNoticeCommand[] = []

beforeEach(() => {
  published = []
  _resetUserResumeNoticesForTest()
  _setUserResumeNoticeSinkForTest(cmd => {
    published.push(cmd)
  })
})

/** 与实现同源的目标会话 id（publish 内懒 import 同一单例）。 */
async function targetSessionId(): Promise<string> {
  const { getSessionId } = await import('src/bootstrap/state.js')
  return getSessionId()
}

describe('buildUserResumeNoticeValue', () => {
  test('官方制式：summary + <note> body + passive 标记', () => {
    const value = buildUserResumeNoticeValue(
      'agnt_r1',
      'scout agent',
      'sess-target-1',
    )
    // 标签名取自同一 constants 注册表（全量并发跑里可能被
    // LocalAgentTask.test 的 xml mock 特化——断言与实现同源即判等价）。
    expect(value).toContain(`<${TASK_NOTIFICATION_TAG} passive="true">`)
    expect(value).toContain(`<${TASK_ID_TAG}>agnt_r1</${TASK_ID_TAG}>`)
    expect(value).toContain(
      `<${USER_RESUME_NOTICE_AGENT_ID_TAG}>sess-target-1</${USER_RESUME_NOTICE_AGENT_ID_TAG}>`,
    )
    expect(value).toContain(
      `<${SUMMARY_TAG}>The agent "scout agent" was resumed by the user</${SUMMARY_TAG}>`,
    )
    expect(value).toContain(
      '<note>The user resumed this agent from its transcript view; it is running again. Do not treat its work as cancelled or relaunch it; its result arrives in a later task-notification for this task-id.</note>',
    )
    expect(value.endsWith(`</${TASK_NOTIFICATION_TAG}>`)).toBe(true)
  })

  test('R1-low：agentId 字段随 payload（官方命令形状 agentId:r）', () => {
    // 官方 Eyo 信封 agentId=to（目标会话）；CCH 消费面以 agentId===undefined
    // 判主线程，故随 payload 值携带（<agent-id> 目标会话 id）。
    const value = buildUserResumeNoticeValue(
      'agnt_r1b',
      'scout agent',
      'sess-parent-9',
    )
    expect(value).toMatch(
      new RegExp(
        `<${USER_RESUME_NOTICE_AGENT_ID_TAG}>[^<\\s]+</${USER_RESUME_NOTICE_AGENT_ID_TAG}>`,
      ),
    )
  })
})

describe('publishUserResumeNotice', () => {
  test('入队官方命令形状（mode/priority/skipAttachments/userResumeNotice/passive/taskId）', async () => {
    const enqueued = await publishUserResumeNotice('agnt_r2', 'worker')
    expect(enqueued).toBe(true)
    expect(published).toHaveLength(1)

    const cmd = published[0]!
    expect(cmd.mode).toBe('task-notification')
    expect(cmd.priority).toBe(USER_RESUME_NOTICE_PRIORITY)
    expect(USER_RESUME_NOTICE_PRIORITY).toBe('next')
    expect(cmd.skipAttachments).toBe(true)
    expect(cmd.userResumeNotice).toBe(true)
    expect(cmd.passive).toBe(true)
    expect(cmd.taskId).toBe('agnt_r2')
    expect(cmd.value).toBe(
      buildUserResumeNoticeValue('agnt_r2', 'worker', await targetSessionId()),
    )
    expect(cmd.value).toContain(USER_RESUME_NOTICE_BODY.trim())
  })

  test('模块级去重：同 taskId 只通知一次', async () => {
    expect(await publishUserResumeNotice('agnt_r3', 'a')).toBe(true)
    expect(await publishUserResumeNotice('agnt_r3', 'a (second resume)')).toBe(
      false,
    )
    expect(hasUserResumeNotice('agnt_r3')).toBe(true)
    // 队列里仍只有第一条
    expect(published).toHaveLength(1)
    expect(published[0]!.value).toBe(
      buildUserResumeNoticeValue('agnt_r3', 'a', await targetSessionId()),
    )
  })

  test('不同 taskId 各自通知', async () => {
    expect(await publishUserResumeNotice('agnt_r4', 'a')).toBe(true)
    expect(await publishUserResumeNotice('agnt_r5', 'b')).toBe(true)
    expect(published).toHaveLength(2)
    expect(published.map(c => c.taskId)).toEqual(['agnt_r4', 'agnt_r5'])
  })

  test('去重位可经测试缝重置', async () => {
    expect(await publishUserResumeNotice('agnt_r6', 'a')).toBe(true)
    _resetUserResumeNoticesForTest()
    expect(hasUserResumeNotice('agnt_r6')).toBe(false)
    expect(await publishUserResumeNotice('agnt_r6', 'a')).toBe(true)
  })
})
