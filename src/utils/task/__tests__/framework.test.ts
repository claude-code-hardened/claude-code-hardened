import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'
// ─── Mocks ───

const noop = () => {}

mock.module('src/utils/debug.ts', debugMock)

const sdkEvents: any[] = []
mock.module('src/utils/sdkEventQueue.js', () => ({
  enqueueSdkEvent: (event: any) => sdkEvents.push(event),
}))

mock.module('src/utils/task/diskOutput.js', () => ({
  getTaskOutputPath: (id: string) => `/tmp/output/${id}`,
  getTaskOutputDelta: async () => null,
  evictTaskOutput: noop,
  initTaskOutputAsSymlink: async () => {},
}))

// 保留原文件的 messageQueueManager mock 面（仅 enqueuePendingNotification），
// 升级为录制器：still-running 快照注入（CCH #52/#44）的断言面。
const queuedNotifications: any[] = []
mock.module('src/utils/messageQueueManager.js', () => ({
  enqueuePendingNotification: (cmd: any) => {
    queuedNotifications.push(cmd)
  },
}))

// ─── Import after mocks ───

const {
  updateTaskState,
  registerTask,
  evictTerminalTask,
  generateTaskAttachments,
  POLL_INTERVAL_MS,
  PANEL_GRACE_MS,
  buildStillRunningReminders,
  enqueueStillRunningReminder,
  _resetStillRunningReminderForTest,
} = await import('../framework.js')

const { _resetTaskRegistryForTest, recordTaskHandle, getAllTaskHandleRecords } =
  await import('src/services/taskRegistry/taskRegistry.js')

let tempDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  tempDir = join(
    tmpdir(),
    `framework-still-running-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  )
  await mkdir(tempDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  await _resetTaskRegistryForTest()
  _resetStillRunningReminderForTest()
  queuedNotifications.length = 0
})

afterEach(async () => {
  await _resetTaskRegistryForTest()
  _resetStillRunningReminderForTest()
  queuedNotifications.length = 0
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  await rm(tempDir, { recursive: true, force: true })
  sdkEvents.length = 0
})

// ─── Helpers ───

function makeTask(overrides: Record<string, any> = {}): any {
  return {
    id: 'task-001',
    type: 'local_agent' as const,
    status: 'running' as const,
    description: 'Test task',
    startTime: Date.now(),
    outputFile: '/tmp/output/task-001',
    outputOffset: 0,
    notified: false,
    ...overrides,
  }
}

type AppStateLike = { tasks: Record<string, any> }
type SetAppStateLike = (f: (prev: AppStateLike) => AppStateLike) => void

function createSetAppState(initial: AppStateLike = { tasks: {} }): {
  setAppState: SetAppStateLike
  getState: () => AppStateLike
} {
  let state = initial
  return {
    setAppState: f => {
      state = f(state)
    },
    getState: () => state,
  }
}

afterEach(() => {
  sdkEvents.length = 0
})

// ─── Tests ───

describe('updateTaskState', () => {
  test('updates task in AppState', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: { 'task-001': makeTask({ status: 'running' }) },
    })

    updateTaskState('task-001', setAppState as any, (task: any) => ({
      ...task,
      status: 'completed',
    }))

    expect(getState().tasks['task-001'].status).toBe('completed')
  })

  test('returns same reference when updater returns same task (no-op)', () => {
    const task = makeTask({ status: 'running' })
    const { setAppState, getState } = createSetAppState({
      tasks: { 'task-001': task },
    })

    updateTaskState('task-001', setAppState as any, (t: any) => t)

    // Should be the exact same reference
    expect(getState().tasks['task-001']).toBe(task)
  })

  test('skips if task not found', () => {
    const { setAppState, getState } = createSetAppState({ tasks: {} })

    updateTaskState('nonexistent', setAppState as any, (t: any) => ({
      ...t,
      status: 'completed',
    }))

    // No crash, tasks unchanged
    expect(Object.keys(getState().tasks)).toHaveLength(0)
  })
})

describe('registerTask', () => {
  test('adds task to AppState.tasks', () => {
    const { setAppState, getState } = createSetAppState()

    registerTask(makeTask(), setAppState as any)

    expect(getState().tasks['task-001']).toBeDefined()
    expect(getState().tasks['task-001'].status).toBe('running')
  })

  test('emits SDK event for new task', () => {
    const { setAppState } = createSetAppState()

    registerTask(makeTask(), setAppState as any)

    expect(sdkEvents).toHaveLength(1)
    expect(sdkEvents[0].subtype).toBe('task_started')
    expect(sdkEvents[0].task_id).toBe('task-001')
  })

  test('merges retain on re-register', () => {
    const { setAppState, getState } = createSetAppState()

    // First registration
    registerTask(makeTask({ retain: true }), setAppState as any)

    // Re-register (resume)
    registerTask(makeTask({ retain: false }), setAppState as any)

    // retain should be preserved from first registration
    expect(getState().tasks['task-001'].retain).toBe(true)
    // Only one SDK event (re-register skips emit)
    expect(sdkEvents).toHaveLength(1)
  })
})

describe('evictTerminalTask', () => {
  test('removes terminal+notified task', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: {
        'task-001': makeTask({
          status: 'completed',
          notified: true,
          evictAfter: Date.now() - 1,
        }),
      },
    })

    evictTerminalTask('task-001', setAppState as any)

    expect(getState().tasks['task-001']).toBeUndefined()
  })

  test('skips if task not terminal', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: { 'task-001': makeTask({ status: 'running', notified: true }) },
    })

    evictTerminalTask('task-001', setAppState as any)

    expect(getState().tasks['task-001']).toBeDefined()
  })

  test('skips if task not notified', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: { 'task-001': makeTask({ status: 'completed', notified: false }) },
    })

    evictTerminalTask('task-001', setAppState as any)

    expect(getState().tasks['task-001']).toBeDefined()
  })

  test('skips if within evictAfter grace period', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: {
        'task-001': makeTask({
          status: 'completed',
          notified: true,
          evictAfter: Date.now() + 60000, // 60s in the future
          retain: false,
        }),
      },
    })

    evictTerminalTask('task-001', setAppState as any)

    expect(getState().tasks['task-001']).toBeDefined()
  })

  test('skips if task not found', () => {
    const { setAppState, getState } = createSetAppState({ tasks: {} })

    evictTerminalTask('nonexistent', setAppState as any)

    // No crash
    expect(Object.keys(getState().tasks)).toHaveLength(0)
  })
})

describe('constants', () => {
  test('POLL_INTERVAL_MS is 1000', () => {
    expect(POLL_INTERVAL_MS).toBe(1000)
  })

  test('PANEL_GRACE_MS is 30000', () => {
    expect(PANEL_GRACE_MS).toBe(30_000)
  })
})

// ─── CCH #52/#44: still-running 快照注入（Q2 按官方 8781 原文纠偏） ─────────

describe('buildStillRunningReminders', () => {
  test('无 running 句柄 → 空数组', () => {
    expect(buildStillRunningReminders()).toEqual([])
  })

  test('local_agent running → 官方 8781 agent 分支逐字（每任务一信使）', () => {
    recordTaskHandle({
      id: 'agnt_snap01',
      type: 'local_agent',
      status: 'running',
      description: 'scout & <builder>',
    })
    const reminders = buildStillRunningReminders()
    expect(reminders).toHaveLength(1)
    const reminder = reminders[0]!
    expect(reminder.startsWith('<system-reminder>')).toBe(true)
    expect(reminder.endsWith('</system-reminder>')).toBe(true)
    // 官方逐字（0001/module-006:8781 task_status running agent 分支）：
    // `Background agent "${desc}" (${id}) is still running.` +
    // `Do NOT spawn a duplicate. You will be notified when it completes.` +
    // 无输出文件尾句 = SendMessage 催报。agent 分支原文无 TaskStop 续句。
    expect(reminder).toContain(
      'Background agent "scout &amp; &lt;builder&gt;" (agnt_snap01) is still running. Do NOT spawn a duplicate. You will be notified when it completes. Send it a message with SendMessage if you need a progress report before then.',
    )
    expect(reminder.includes('Do not start it again')).toBe(false)
  })

  test('local_agent 带输出文件 → agent 分支有文件尾句（读 partial output + SendMessage）', () => {
    recordTaskHandle({
      id: 'agnt_snap10',
      type: 'local_agent',
      status: 'running',
      description: 'with-output',
      outputFile: '/tmp/output/agnt_snap10',
    })
    const reminder = buildStillRunningReminders()[0]!
    expect(reminder).toContain(
      'Background agent "with-output" (agnt_snap10) is still running. Do NOT spawn a duplicate. You will be notified when it completes. You can read partial output at /tmp/output/agnt_snap10 or send it a message with SendMessage.',
    )
  })

  test('local_bash running → 官方 8781 bash 分支逐字（Background shell + TaskStop 续句）', () => {
    recordTaskHandle({
      id: 'agnt_snap02',
      type: 'local_bash',
      status: 'running',
    })
    const reminder = buildStillRunningReminders()[0]!
    // 官方 bash 分支：`Background shell ${id} ("${desc}") is still running.`
    // + `Do not start it again; to restart it, stop it with TaskStop first.`
    expect(reminder).toContain(
      'Background shell agnt_snap02 ("") is still running. Do not start it again; to restart it, stop it with TaskStop first.',
    )
    expect(reminder.includes('Do NOT spawn a duplicate')).toBe(false)
  })

  test('多 running 句柄 → 每任务一条信使（官方每任务一信使，不跨任务合并）', () => {
    recordTaskHandle({
      id: 'agnt_snap11',
      type: 'local_agent',
      status: 'running',
      description: 'a',
    })
    recordTaskHandle({
      id: 'agnt_snap12',
      type: 'local_bash',
      status: 'running',
      description: 'b',
    })
    const reminders = buildStillRunningReminders()
    expect(reminders).toHaveLength(2)
    expect(reminders[0]).toContain('Background agent "a" (agnt_snap11)')
    expect(reminders[1]).toContain('Background shell agnt_snap12 ("b")')
  })
})

describe('enqueueStillRunningReminder', () => {
  test('首注入：task-notification 信封 + isMeta + next 优先级', async () => {
    recordTaskHandle({
      id: 'agnt_snap03',
      type: 'local_agent',
      status: 'running',
      description: 'worker',
    })
    expect(
      getAllTaskHandleRecords().some(
        r => r.id === 'agnt_snap03' && r.status === 'running',
      ),
    ).toBe(true)
    const enqueued = await Promise.resolve(enqueueStillRunningReminder())
    expect(enqueued).toBe(true)
    expect(queuedNotifications).toHaveLength(1)
    const cmd = queuedNotifications[0]!
    expect(cmd.mode).toBe('task-notification')
    expect(cmd.priority).toBe('next')
    expect(cmd.isMeta).toBe(true)
    expect(typeof cmd.value).toBe('string')
    expect(cmd.value).toContain('<system-reminder>')
  })

  test('内容未变不再重复入队（防空闲唤醒自激）', () => {
    recordTaskHandle({
      id: 'agnt_snap04',
      type: 'local_agent',
      status: 'running',
      description: 'worker',
    })
    expect(enqueueStillRunningReminder()).toBe(true)
    const count = queuedNotifications.length
    expect(enqueueStillRunningReminder()).toBe(false)
    expect(queuedNotifications.length).toBe(count)
  })

  test('集合变化后重新注入（完成 → 剩集快照更新，逐任务重发）', () => {
    recordTaskHandle({
      id: 'agnt_snap05',
      type: 'local_agent',
      status: 'running',
      description: 'a',
    })
    recordTaskHandle({
      id: 'agnt_snap06',
      type: 'local_agent',
      status: 'running',
      description: 'b',
    })
    expect(enqueueStillRunningReminder()).toBe(true)
    // 首注：每任务一信使 → 两条
    expect(queuedNotifications).toHaveLength(2)
    // a 完成：still-running 集收缩 → 快照变化 → 剩集任务按官方制式重发
    recordTaskHandle({
      id: 'agnt_snap05',
      type: 'local_agent',
      status: 'completed',
      exitKind: 'completed',
    })
    expect(enqueueStillRunningReminder()).toBe(true)
    const last = queuedNotifications.at(-1)!
    expect(last.value).not.toContain('agnt_snap05')
    expect(last.value).toContain(
      'Background agent "b" (agnt_snap06) is still running',
    )
  })

  test('全部完成后不再注入（上一轮 stale 快照自然终止）', () => {
    recordTaskHandle({
      id: 'agnt_snap07',
      type: 'local_agent',
      status: 'running',
      description: 'solo',
    })
    expect(enqueueStillRunningReminder()).toBe(true)
    recordTaskHandle({
      id: 'agnt_snap07',
      type: 'local_agent',
      status: 'completed',
      exitKind: 'completed',
    })
    expect(enqueueStillRunningReminder()).toBe(false)
  })

  test('R1-high staleness：completed → revive(unpark) 同名快照再注入', () => {
    recordTaskHandle({
      id: 'agnt_snap09',
      type: 'local_agent',
      status: 'running',
      description: 'revive-me',
    })
    expect(enqueueStillRunningReminder()).toBe(true)
    expect(queuedNotifications).toHaveLength(1)
    // 完成 → running 集清空 → 不注入，且去重位复位
    recordTaskHandle({
      id: 'agnt_snap09',
      type: 'local_agent',
      status: 'completed',
      exitKind: 'completed',
    })
    expect(enqueueStillRunningReminder()).toBe(false)
    expect(queuedNotifications).toHaveLength(1)
    // 复活（reopenRunning 显式重开，官方 $M unpark 现仅清停车位；
    // resumeAgentBackground 同参）：同 id 同名再次 running —— 旧串去重位
    // 若不复位会吞掉同名快照。
    recordTaskHandle({
      id: 'agnt_snap09',
      type: 'local_agent',
      status: 'running',
      description: 'revive-me',
      reopenRunning: true,
    })
    expect(enqueueStillRunningReminder()).toBe(true)
    expect(queuedNotifications).toHaveLength(2)
    expect(queuedNotifications[1]!.value).toContain(
      'Background agent "revive-me" (agnt_snap09) is still running. Do NOT spawn a duplicate.',
    )
  })

  test('generateTaskAttachments 每轮驱动注入（组装面接线）', async () => {
    recordTaskHandle({
      id: 'agnt_snap08',
      type: 'local_agent',
      status: 'running',
      description: 'driven',
    })
    await generateTaskAttachments({ tasks: {} } as any)
    expect(queuedNotifications.length).toBeGreaterThanOrEqual(1)
    expect(queuedNotifications[0]!.value).toContain(
      'Background agent "driven" (agnt_snap08) is still running',
    )
  })

  test('信封带 passive（官方 so():9229 排除 passive——纯快照不唤醒 query 轮）', () => {
    recordTaskHandle({
      id: 'agnt_pass01',
      type: 'local_agent',
      status: 'running',
      description: 'passive-probe',
    })
    expect(enqueueStillRunningReminder()).toBe(true)
    expect(queuedNotifications).toHaveLength(1)
    // 缺 passive 时 hasUserIntentCommandsInQueue 把 still-running 误判为
    // user intent，空闲队列被唤醒成无谓新轮（自激温床）—— 回归门。
    expect(queuedNotifications[0]!.passive).toBe(true)
    expect(queuedNotifications[0]!.isMeta).toBe(true)
    expect(queuedNotifications[0]!.mode).toBe('task-notification')
  })
})

// ─── CCH 审查修复（回归官方 :8420/:8428）：死讯不再经附件面广播 ──────────

describe('generateTaskAttachments — 死讯零广播（官方 completed 由 tool_result 送达）', () => {
  test('未投终态句柄不进入 task_status 附件（补投唯一咽喉 = resume 单点）', async () => {
    recordTaskHandle({
      id: 'bshahead01',
      type: 'local_bash',
      status: 'failed',
      exitKind: 'failed',
      description: 'dead shell, not broadcast',
    })
    recordTaskHandle({
      id: 'bshahead02',
      type: 'local_agent',
      status: 'completed',
      exitKind: 'completed',
      description: 'delivered in life',
    })
    const { attachments } = await generateTaskAttachments({
      tasks: {},
    } as any)
    // 无论未投/已投，死讯面均不出附件——上一版的附件广播是陈年回放与
    // 自激唤醒的温床；补投收口到 deliverOnResume 单点咽喉。
    expect(attachments.find(a => a.taskId === 'bshahead01')).toBeUndefined()
    expect(attachments.find(a => a.taskId === 'bshahead02')).toBeUndefined()
    expect(attachments).toHaveLength(0)
  })
})
