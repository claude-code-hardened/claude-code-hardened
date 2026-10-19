import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  clearCommandQueue,
  dequeue,
  dequeueAllMatching,
  enqueue,
  enqueuePendingNotification,
  hasCommandsInQueue,
  hasUserIntentCommandsInQueue,
  isPassiveNotification,
  isQueuedCommandVisible,
  isSlashCommand,
  isUserIntentCommand,
  peek,
  resetCommandQueue,
  shouldSkipAttachmentsForCommand,
} from '../messageQueueManager.js'

// Reset module-level queue state between tests
beforeEach(() => {
  resetCommandQueue()
})

afterEach(() => {
  resetCommandQueue()
})

describe('messageQueueManager.isSlashCommand', () => {
  test('treats normal slash commands as slash commands', () => {
    expect(isSlashCommand({ value: '/help', mode: 'prompt' } as any)).toBe(true)
  })

  test('keeps remote bridge slash commands slash-routed when bridgeOrigin is set', () => {
    expect(
      isSlashCommand({
        value: '/proactive',
        mode: 'prompt',
        skipSlashCommands: true,
        bridgeOrigin: true,
      } as any),
    ).toBe(true)
  })

  test('keeps skipSlashCommands text-only when bridgeOrigin is absent', () => {
    expect(
      isSlashCommand({
        value: '/proactive',
        mode: 'prompt',
        skipSlashCommands: true,
      } as any),
    ).toBe(false)
  })
})

describe('messageQueueManager.enqueue', () => {
  test('adds command to queue with default next priority', () => {
    enqueue({ value: 'hello', mode: 'prompt' } as any)
    expect(hasCommandsInQueue()).toBe(true)
    const cmd = dequeue()
    expect(cmd).toBeDefined()
    expect(cmd!.value).toBe('hello')
    expect(cmd!.priority).toBe('next')
  })

  test('preserves explicit priority', () => {
    enqueue({ value: 'urgent', mode: 'prompt', priority: 'now' } as any)
    const cmd = dequeue()
    expect(cmd!.priority).toBe('now')
  })
})

describe('messageQueueManager.enqueuePendingNotification', () => {
  test('adds command with later priority', () => {
    enqueuePendingNotification({
      value: '<task-notification/>',
      mode: 'task-notification',
    } as any)
    const cmd = dequeue()
    expect(cmd).toBeDefined()
    expect(cmd!.priority).toBe('later')
    expect(cmd!.mode).toBe('task-notification')
  })
})

describe('messageQueueManager.dequeue', () => {
  test('returns undefined when queue empty', () => {
    expect(dequeue()).toBeUndefined()
  })

  test('returns highest priority command', () => {
    enqueuePendingNotification({
      value: 'later-cmd',
      mode: 'task-notification',
    } as any)
    enqueue({ value: 'next-cmd', mode: 'prompt' } as any)
    enqueue({ value: 'now-cmd', mode: 'prompt', priority: 'now' } as any)

    const first = dequeue()
    expect(first!.value).toBe('now-cmd')

    const second = dequeue()
    expect(second!.value).toBe('next-cmd')

    const third = dequeue()
    expect(third!.value).toBe('later-cmd')
  })

  test('FIFO within same priority', () => {
    enqueue({ value: 'first', mode: 'prompt' } as any)
    enqueue({ value: 'second', mode: 'prompt' } as any)

    expect(dequeue()!.value).toBe('first')
    expect(dequeue()!.value).toBe('second')
  })

  test('respects filter parameter', () => {
    enqueue({ value: 'prompt-cmd', mode: 'prompt' } as any)
    enqueuePendingNotification({
      value: 'task-cmd',
      mode: 'task-notification',
    } as any)

    // Filter to only task-notification commands
    const cmd = dequeue(c => c.mode === 'task-notification')
    expect(cmd).toBeDefined()
    expect(cmd!.value).toBe('task-cmd')

    // Prompt command should still be in queue
    expect(hasCommandsInQueue()).toBe(true)
    expect(dequeue()!.value).toBe('prompt-cmd')
  })
})

describe('messageQueueManager.peek', () => {
  test('returns undefined when queue empty', () => {
    expect(peek()).toBeUndefined()
  })

  test('returns highest priority without removing', () => {
    enqueuePendingNotification({
      value: 'later',
      mode: 'task-notification',
    } as any)
    enqueue({ value: 'next', mode: 'prompt' } as any)

    expect(peek()!.value).toBe('next')
    expect(hasCommandsInQueue()).toBe(true)
    expect(dequeue()!.value).toBe('next')
  })
})

describe('messageQueueManager.dequeueAllMatching', () => {
  test('removes all matching commands', () => {
    enqueue({ value: 'a', mode: 'prompt' } as any)
    enqueue({ value: 'b', mode: 'task-notification' } as any)
    enqueue({ value: 'c', mode: 'task-notification' } as any)

    const matched = dequeueAllMatching(c => c.mode === 'task-notification')
    expect(matched).toHaveLength(2)
    expect(matched.map(c => c.value)).toEqual(['b', 'c'])

    // Remaining command should still be in queue
    expect(dequeue()!.value).toBe('a')
  })

  test('returns empty array when no matches', () => {
    enqueue({ value: 'a', mode: 'prompt' } as any)
    const matched = dequeueAllMatching(c => c.mode === 'bash')
    expect(matched).toHaveLength(0)
    expect(hasCommandsInQueue()).toBe(true)
  })

  test('returns empty array when queue empty', () => {
    const matched = dequeueAllMatching(() => true)
    expect(matched).toHaveLength(0)
  })
})

describe('messageQueueManager.clearCommandQueue', () => {
  test('removes all commands', () => {
    enqueue({ value: 'a', mode: 'prompt' } as any)
    enqueue({ value: 'b', mode: 'prompt' } as any)
    expect(hasCommandsInQueue()).toBe(true)

    clearCommandQueue()
    expect(hasCommandsInQueue()).toBe(false)
  })

  test('no-op on empty queue', () => {
    clearCommandQueue()
    expect(hasCommandsInQueue()).toBe(false)
  })
})

describe('messageQueueManager priority ordering', () => {
  test('now dequeued before next and later', () => {
    enqueuePendingNotification({
      value: 'later',
      mode: 'task-notification',
    } as any)
    enqueue({ value: 'next', mode: 'prompt' } as any)
    enqueue({ value: 'now', mode: 'prompt', priority: 'now' } as any)

    expect(dequeue()!.value).toBe('now')
    expect(dequeue()!.value).toBe('next')
    expect(dequeue()!.value).toBe('later')
  })

  test('next dequeued before later', () => {
    enqueuePendingNotification({
      value: 'later',
      mode: 'task-notification',
    } as any)
    enqueue({ value: 'next', mode: 'prompt' } as any)

    expect(dequeue()!.value).toBe('next')
    expect(dequeue()!.value).toBe('later')
  })
})

// ── CCH #50 mailbox 三面 + CCH #52 待投递去重 ────────────────────────────

describe('messageQueueManager.enqueuePendingNotification ahead', () => {
  test('ahead:true 插队到队列首（跳过 FIFO）', () => {
    enqueuePendingNotification({
      value: 'old-1',
      mode: 'task-notification',
    } as any)
    enqueuePendingNotification({
      value: 'old-2',
      mode: 'task-notification',
    } as any)
    enqueuePendingNotification({
      value: 'urgent',
      mode: 'task-notification',
      ahead: true,
    } as any)

    expect(dequeue()!.value).toBe('urgent')
    expect(dequeue()!.value).toBe('old-1')
    expect(dequeue()!.value).toBe('old-2')
  })

  test('ahead 默认 undefined 时保持 FIFO 追加', () => {
    enqueuePendingNotification({
      value: 'first',
      mode: 'task-notification',
    } as any)
    enqueuePendingNotification({
      value: 'second',
      mode: 'task-notification',
    } as any)
    expect(dequeue()!.value).toBe('first')
    expect(dequeue()!.value).toBe('second')
  })
})

describe('messageQueueManager passive/skipAttachments envelope', () => {
  test('passive 命令不进队列预览（isQueuedCommandVisible false）', () => {
    enqueuePendingNotification({
      value:
        '<task-notification><summary>resumed</summary></task-notification>',
      mode: 'task-notification',
      passive: true,
    } as any)
    const queued = peek()!
    expect(isPassiveNotification(queued)).toBe(true)
    expect(isQueuedCommandVisible(queued)).toBe(false)
  })

  test('passive 使本可预览的命令静默（prompt 对照组）', () => {
    enqueue({ value: 'human', mode: 'prompt' } as any)
    expect(isQueuedCommandVisible(peek()!)).toBe(true)
    dequeue()
    enqueue({
      value: 'system-but-silent',
      mode: 'prompt',
      passive: true,
    } as any)
    expect(isPassiveNotification(peek()!)).toBe(true)
    expect(isQueuedCommandVisible(peek()!)).toBe(false)
  })

  test('skipAttachments 信封位随命令保存并可读取', () => {
    enqueuePendingNotification({
      value: '<task-notification><summary>x</summary></task-notification>',
      mode: 'task-notification',
      skipAttachments: true,
      userResumeNotice: true,
      taskId: 'agnt_x',
    } as any)
    const queued = peek()!
    expect(shouldSkipAttachmentsForCommand(queued)).toBe(true)
    expect((queued as { userResumeNotice?: boolean }).userResumeNotice).toBe(
      true,
    )
    expect((queued as { taskId?: string }).taskId).toBe('agnt_x')
  })
})

describe('messageQueueManager (taskId,status) 待投递去重', () => {
  const notify = (taskId: string, status: string) =>
    `<task-notification><task-id>${taskId}</task-id><status>${status}</status><summary>s</summary></task-notification>`

  test('同 (taskId,status) 已 pending 时跳过入队', () => {
    enqueuePendingNotification({
      value: notify('agnt_d1', 'completed'),
      mode: 'task-notification',
    } as any)
    expect(hasCommandsInQueue()).toBe(true)
    enqueuePendingNotification({
      value: notify('agnt_d1', 'completed'),
      mode: 'task-notification',
    } as any)
    // 队列仍只有一条
    expect(dequeueAllMatching(() => true)).toHaveLength(1)
  })

  test('不同 status 不去重（killed 与 completed 是不同死讯）', () => {
    enqueuePendingNotification({
      value: notify('agnt_d2', 'killed'),
      mode: 'task-notification',
    } as any)
    enqueuePendingNotification({
      value: notify('agnt_d2', 'completed'),
      mode: 'task-notification',
    } as any)
    expect(dequeueAllMatching(() => true)).toHaveLength(2)
  })

  test('不同 taskId 不去重', () => {
    enqueuePendingNotification({
      value: notify('agnt_a', 'completed'),
      mode: 'task-notification',
    } as any)
    enqueuePendingNotification({
      value: notify('agnt_b', 'completed'),
      mode: 'task-notification',
    } as any)
    expect(dequeueAllMatching(() => true)).toHaveLength(2)
  })

  test('去重只看 pending（已投递出队后可再次入队）', () => {
    enqueuePendingNotification({
      value: notify('agnt_d3', 'completed'),
      mode: 'task-notification',
    } as any)
    dequeue() // 投递
    enqueuePendingNotification({
      value: notify('agnt_d3', 'completed'),
      mode: 'task-notification',
    } as any)
    expect(dequeueAllMatching(() => true)).toHaveLength(1)
  })

  test('非 task-notification / 缺 task-id 的命令不去重', () => {
    enqueuePendingNotification({
      value: 'no-tags',
      mode: 'task-notification',
    } as any)
    enqueuePendingNotification({
      value: 'no-tags',
      mode: 'task-notification',
    } as any)
    enqueue({ value: 'no-tags', mode: 'prompt' } as any)
    enqueue({ value: 'no-tags', mode: 'prompt' } as any)
    expect(dequeueAllMatching(() => true)).toHaveLength(4)
  })
})

// ── CCH #50/R1-中: passive 消费面（官方 so() 口径） ──────────────────────

describe('messageQueueManager hasUserIntentCommandsInQueue (官方 so())', () => {
  test('空队列 → 无 user intent', () => {
    expect(hasUserIntentCommandsInQueue()).toBe(false)
  })

  test('仅 passive 命令 → 不算 user intent（不触发新 query 轮）', () => {
    enqueuePendingNotification({
      value:
        '<task-notification><task-id>a</task-id><status>running</status></task-notification>',
      mode: 'task-notification',
      passive: true,
    } as any)
    expect(hasCommandsInQueue()).toBe(true)
    expect(isPassiveNotification(peek()!)).toBe(true)
    expect(hasUserIntentCommandsInQueue()).toBe(false)
  })

  test('passive + 真实命令混合 → 有 user intent', () => {
    enqueuePendingNotification({
      value: 'resume-notice',
      mode: 'task-notification',
      passive: true,
    } as any)
    expect(hasUserIntentCommandsInQueue()).toBe(false)
    enqueue({ value: 'human prompt', mode: 'prompt' } as any)
    expect(hasUserIntentCommandsInQueue()).toBe(true)
  })

  test('isUserIntentCommand 消费面判定逐条成立', () => {
    const passiveCmd = {
      value: 'x',
      mode: 'task-notification',
      passive: true,
    } as any
    const intentCmd = { value: 'y', mode: 'prompt' } as any
    expect(isUserIntentCommand(passiveCmd)).toBe(false)
    expect(isUserIntentCommand(intentCmd)).toBe(true)
  })
})
