import { beforeEach, describe, expect, mock, test } from 'bun:test'

// SleepTool 每 500ms 轮询共享命令队列（惰性 require
// 'src/utils/messageQueueManager.js'）。其他测试文件（LocalAgentTask、
// LocalWorkflowTask、task framework、agentToolUtils）对该模块注册的进程全局
// mock 的 enqueue 与 hasCommandsInQueue 互不自洽——唤醒轮询永不触发，本测试
// 睡满 10s（CI：timeout after 5000ms）。这里注册一个带状态、读写在同一实例
// 上自洽的 mock（进程级 last-write-wins），覆盖真实模块的全部导出面，并让
// 断言走同一实例，保证确定性。
type QCmd = Record<string, unknown>
const queue: QCmd[] = []
const PRIORITY_ORDER: Record<string, number> = { now: 0, next: 1, later: 2 }
const priorityOf = (c: QCmd): number => PRIORITY_ORDER[String(c.priority)] ?? 1
const byPriority = (a: QCmd, b: QCmd): number => priorityOf(a) - priorityOf(b)
const removeMatching = (pred: (c: QCmd) => boolean): QCmd[] => {
  const removed = queue.filter(pred)
  const kept = queue.filter(c => !pred(c))
  queue.length = 0
  queue.push(...kept)
  return removed
}
const isEditable = (c: QCmd): boolean =>
  c.mode === 'prompt' || c.mode === 'bash'

const queueMock = {
  subscribeToCommandQueue: (_fn: unknown) => () => {},
  getCommandQueueSnapshot: () => Object.freeze(queue.map(c => ({ ...c }))),
  getCommandQueue: () => queue.map(c => ({ ...c })),
  getCommandQueueLength: () => queue.length,
  hasCommandsInQueue: () => queue.length > 0,
  recheckCommandQueue: () => {},
  enqueue: (command: QCmd) => {
    queue.push({ ...command, priority: command.priority ?? 'next' })
  },
  enqueuePendingNotification: (command: QCmd) => {
    queue.push({ ...command, priority: command.priority ?? 'later' })
  },
  dequeue: (filter?: (c: QCmd) => boolean): QCmd | undefined => {
    const candidates = queue.filter(c => !filter || filter(c)).sort(byPriority)
    const first = candidates[0]
    if (!first) return undefined
    return removeMatching(c => c === first)[0]
  },
  dequeueAll: () => removeMatching(() => true),
  peek: (): QCmd | undefined => {
    const first = [...queue].sort(byPriority)[0]
    return first ? { ...first } : undefined
  },
  dequeueAllMatching: (filter: (c: QCmd) => boolean) => removeMatching(filter),
  remove: (commandsToRemove: QCmd[]) =>
    removeMatching(c => commandsToRemove.includes(c)),
  removeByFilter: (filter: (c: QCmd) => boolean) => removeMatching(filter),
  clearCommandQueue: () => {
    queue.length = 0
  },
  resetCommandQueue: () => {
    queue.length = 0
  },
  isPromptInputModeEditable: (c: QCmd) => c.mode === 'prompt',
  isQueuedCommandEditable: isEditable,
  isQueuedCommandVisible: () => true,
  popAllEditable: (filter?: (c: QCmd) => boolean) => ({
    commands: removeMatching(c => isEditable(c) && (!filter || filter(c))),
  }),
  getCommandsByMaxPriority: (max: string) =>
    queue
      .filter(c => priorityOf(c) <= (PRIORITY_ORDER[max] ?? 1))
      .sort(byPriority)
      .map(c => ({ ...c })),
  isSlashCommand: (c: QCmd) =>
    typeof c.value === 'string' && (c.value as string).startsWith('/'),
}

mock.module('src/utils/messageQueueManager.js', () => queueMock)
mock.module('src/utils/messageQueueManager.ts', () => queueMock)

const { SleepTool } = await import('../SleepTool')

describe('SleepTool', () => {
  beforeEach(() => {
    queue.length = 0
  })

  test('declares cancel interrupt behavior', () => {
    expect(SleepTool.interruptBehavior()).toBe('cancel')
  })

  test('wakes early when queued work arrives', async () => {
    const sleepPromise = SleepTool.call({ duration_seconds: 10 }, {
      abortController: new AbortController(),
    } as any)

    setTimeout(() => {
      queueMock.enqueue({
        value: 'wake up',
        mode: 'prompt',
      })
    }, 20)

    const result = await sleepPromise

    expect(result.data.interrupted).toBe(true)
    expect(result.data.slept_seconds).toBeLessThan(10)
    expect(queueMock.getCommandQueue()).toHaveLength(1)
    expect(queueMock.getCommandQueue()[0]).toMatchObject({
      value: 'wake up',
      mode: 'prompt',
    })
  })
})
