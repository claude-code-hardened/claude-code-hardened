/**
 * Tests for useQueueProcessor 唤醒门（W1.6）。
 *
 * 官方真源 docs/reverse-284/0001-chunk-xrzcaagk/module-006-uncategorized.js
 * :9229 `so()`：`return g.some((Ro)=>!_b(Ro)&&Ro.passive!==!0)` —— passive
 * 通知不算 user intent。useQueueProcessor 的 effect 三连门（query 活跃 /
 * 本地 JSX UI / 纯 passive 队列）抽出为 shouldWakeQueueProcessor 纯函数，
 * 本测试直测同源面，并与真实 messageQueueManager 队列互查（入队后按
 * hasUserIntentCommandsInQueue 的真实读数）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  dequeue,
  enqueue,
  enqueuePendingNotification,
  hasUserIntentCommandsInQueue,
  isUserIntentCommand,
  resetCommandQueue,
} from 'src/utils/messageQueueManager.js'
import { shouldWakeQueueProcessor } from '../useQueueProcessor.js'

// 注意：本文件只 import 类型与纯函数面（不触碰 react hooks 执行）——
// useQueueProcessor.js 顶部 import react 仅为 useSyncExternalStore/useEffect
// 绑定，模块加载无副作用。

beforeEach(() => {
  resetCommandQueue()
})

afterEach(() => {
  resetCommandQueue()
})

describe('shouldWakeQueueProcessor（官方 so() 唤醒门）', () => {
  test('纯 passive 队列不 wake（passive 通知不触发新 query 轮）', () => {
    const wake = shouldWakeQueueProcessor({
      isQueryActive: false,
      hasActiveLocalJsxUI: false,
      hasUserIntentCommands: hasUserIntentCommandsInQueue(),
    })
    expect(wake).toBe(false)
  })

  test('hasUserIntentCommands=true 时 wake（真实用户命令面）', () => {
    const wake = shouldWakeQueueProcessor({
      isQueryActive: false,
      hasActiveLocalJsxUI: false,
      hasUserIntentCommands: true,
    })
    expect(wake).toBe(true)
  })

  test('query 活跃时永不 wake（dispatching 面，reservation 已持有）', () => {
    const wake = shouldWakeQueueProcessor({
      isQueryActive: true,
      hasActiveLocalJsxUI: false,
      hasUserIntentCommands: true,
    })
    expect(wake).toBe(false)
  })

  test('本地 JSX UI 占用时永不 wake（permissions 对话框面）', () => {
    const wake = shouldWakeQueueProcessor({
      isQueryActive: false,
      hasActiveLocalJsxUI: true,
      hasUserIntentCommands: true,
    })
    expect(wake).toBe(false)
  })
})

describe('唤醒门与真实队列互查（hasUserIntentCommandsInQueue 读数）', () => {
  test('入 passive task-notification 后门仍关（纯 passive 队列不 wake）', () => {
    // still-running 快照信使（framework enqueueStillRunningReminder 同参）
    enqueuePendingNotification({
      value:
        '<system-reminder>Background agent "x" (a1) is still running. Do NOT spawn a duplicate.</system-reminder>',
      mode: 'task-notification',
      priority: 'next',
      isMeta: true,
      passive: true,
    })
    expect(hasUserIntentCommandsInQueue()).toBe(false)
    expect(
      shouldWakeQueueProcessor({
        isQueryActive: false,
        hasActiveLocalJsxUI: false,
        hasUserIntentCommands: hasUserIntentCommandsInQueue(),
      }),
    ).toBe(false)
  })

  test('非 passive 的 task-notification 即 user intent（官方唤醒源）；纯 passive 队列门关', () => {
    // 官方 so()：Ro.passive!==!0 即计入——无任务通知标记的 task-notification
    // （完成通知）本身就是唤轮源；等它出队后剩下的纯 passive 不再 wake。
    enqueuePendingNotification({
      value:
        '<task-notification><status>completed</status></task-notification>',
      mode: 'task-notification',
    })
    expect(hasUserIntentCommandsInQueue()).toBe(true)
    expect(
      shouldWakeQueueProcessor({
        isQueryActive: false,
        hasActiveLocalJsxUI: false,
        hasUserIntentCommands: hasUserIntentCommandsInQueue(),
      }),
    ).toBe(true)
    // 出队 user-intent 命令后，队列只剩随后入队的纯 passive → 门关
    enqueuePendingNotification({
      value:
        '<system-reminder>Background agent "x" (a1) is still running.</system-reminder>',
      mode: 'task-notification',
      priority: 'next',
      isMeta: true,
      passive: true,
    })
    // 出队 user-intent 命令（'later' 非被动通知被 'next' passive 覆盖——
    // 按 intent 判定摘取该摘的那条），队列只剩纯 passive → 门关
    dequeue(isUserIntentCommand)
    expect(hasUserIntentCommandsInQueue()).toBe(false)
    expect(
      shouldWakeQueueProcessor({
        isQueryActive: false,
        hasActiveLocalJsxUI: false,
        hasUserIntentCommands: hasUserIntentCommandsInQueue(),
      }),
    ).toBe(false)
  })

  test('无任务通知的 task-notification（非 passive）即 user intent（官方唤醒源）', () => {
    enqueuePendingNotification({
      value:
        '<task-notification><status>completed</status></task-notification>',
      mode: 'task-notification',
      priority: 'later',
    })
    expect(hasUserIntentCommandsInQueue()).toBe(true)
    expect(
      shouldWakeQueueProcessor({
        isQueryActive: false,
        hasActiveLocalJsxUI: false,
        hasUserIntentCommands: hasUserIntentCommandsInQueue(),
      }),
    ).toBe(true)
  })
})
