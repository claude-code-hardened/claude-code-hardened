/**
 * Tests for src/services/taskRegistry/taskRegistry.ts — CCH #38 中央任务
 * 句柄注册表（官方对齐：docs/reverse-284/decompiled/0002-chunk-zrkp23rq/
 * module-005-uncategorized.js:3417 起的 handle 渲染面 status/notified/
 * quietlyParked；0001-chunk-xrzcaagk/module-006-uncategorized.js:1919/
 * 2116/2186 的 task-notification 队列 origin 语义 —— 句柄表为本体，通知
 * 只是视图，死后补投轮询可达）。
 *
 * 覆盖：状态迁移落盘快照 / 死讯补投取走置位回写 / reaper 超时判定 /
 * 落盘写失败不抛（console.debug 兜底）。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _flushTaskRegistrySnapshotsForTest,
  _resetTaskRegistryForTest,
  consumeUndeliveredTerminalTasks,
  getAllTaskHandleRecords,
  getTaskHandleRecord,
  getTaskRegistryDiagnostics,
  getTaskSnapshotPath,
  peekUndeliveredTerminalTasks,
  reapSuspiciousTasks,
  recordTaskHandle,
  recordTaskHeartbeat,
  recordTaskHeartbeats,
  sanitizeTaskHandleId,
} from '../taskRegistry.js'

let tempDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  tempDir = join(
    tmpdir(),
    `task-registry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  await mkdir(tempDir, { recursive: true })
  // 指向一个（将要创建的）目录；写失败用例单独再指到文件路径。
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  await _resetTaskRegistryForTest()
})

afterEach(async () => {
  await _resetTaskRegistryForTest()
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  await rm(tempDir, { recursive: true, force: true })
})

describe('taskRegistry — 状态迁移落盘', () => {
  test('spawn 建 running 句柄并全量落盘，终态迁移后快照更新', async () => {
    const t0 = 1_700_000_000_000
    recordTaskHandle({
      id: 'b1test01',
      type: 'local_bash',
      status: 'running',
      description: 'long build',
      startedAt: t0,
      updatedAt: t0,
    })

    await _flushTaskRegistrySnapshotsForTest()
    const path = getTaskSnapshotPath('b1test01')
    expect(path.endsWith(join('tasks', 'b1test01.state.json'))).toBe(true)

    const spawned = JSON.parse(await readFile(path, 'utf8'))
    expect(spawned).toMatchObject({
      id: 'b1test01',
      type: 'local_bash',
      status: 'running',
      notified: false,
      description: 'long build',
      startedAt: t0,
      updatedAt: t0,
    })

    // 状态迁移：running → completed（全量落盘，含 exitKind / updatedAt）
    recordTaskHandle({
      id: 'b1test01',
      type: 'local_bash',
      status: 'completed',
      exitKind: 'completed',
      updatedAt: t0 + 5000,
    })
    await _flushTaskRegistrySnapshotsForTest()

    const terminal = JSON.parse(await readFile(path, 'utf8'))
    expect(terminal.status).toBe('completed')
    expect(terminal.notified).toBe(false)
    expect(terminal.exitKind).toBe('completed')
    expect(terminal.updatedAt).toBe(t0 + 5000)
    expect(terminal.startedAt).toBe(t0)
  })

  test('终态句柄不接受非终态回迁（快照链的迟到写不能诈尸）', async () => {
    recordTaskHandle({
      id: 'a9dead01',
      type: 'local_agent',
      status: 'failed',
      updatedAt: 1000,
    })
    recordTaskHandle({
      id: 'a9dead01',
      type: 'local_agent',
      status: 'running',
      updatedAt: 2000,
    })

    const record = getTaskHandleRecord('a9dead01')
    expect(record?.status).toBe('failed')
    await _flushTaskRegistrySnapshotsForTest()
    const onDisk = JSON.parse(
      await readFile(getTaskSnapshotPath('a9dead01'), 'utf8'),
    )
    expect(onDisk.status).toBe('failed')
  })

  test('快照文件 id 做路径安全清洗', () => {
    expect(sanitizeTaskHandleId('../../evil')).toBe('------evil')
    expect(getTaskSnapshotPath('../x')).not.toContain('..')
  })

  test('quietlyParked 终态句柄直接视为已送达（官方 parked 挂表语义）', async () => {
    recordTaskHandle({
      id: 'a8park01',
      type: 'local_agent',
      status: 'completed',
      quietlyParked: true,
      updatedAt: 42,
    })
    expect(getTaskHandleRecord('a8park01')?.notified).toBe(true)
    expect(consumeUndeliveredTerminalTasks()).toEqual([])

    await _flushTaskRegistrySnapshotsForTest()
    const onDisk = JSON.parse(
      await readFile(getTaskSnapshotPath('a8park01'), 'utf8'),
    )
    expect(onDisk.quietlyParked).toBe(true)
    expect(onDisk.notified).toBe(true)
  })
})

describe('taskRegistry — 死讯补投', () => {
  test('终态且 notified=false 的清单取走即置 notified=true 并回写快照', async () => {
    const t0 = 1_700_000_000_000
    recordTaskHandle({
      id: 'a1test01',
      type: 'local_agent',
      status: 'running',
      description: 'subagent',
      startedAt: t0,
      updatedAt: t0,
    })
    recordTaskHandle({
      id: 'b2test02',
      type: 'local_bash',
      status: 'running',
      description: 'bg shell',
      startedAt: t0,
      updatedAt: t0,
    })
    // 一死一活：死讯面只认终态
    recordTaskHandle({
      id: 'a1test01',
      type: 'local_agent',
      status: 'failed',
      exitKind: 'failed',
      updatedAt: t0 + 10,
    })

    expect(peekUndeliveredTerminalTasks()).toEqual([
      { id: 'a1test01', status: 'failed', exitKind: 'failed' },
    ])

    const delivered = consumeUndeliveredTerminalTasks()
    expect(delivered).toEqual([
      { id: 'a1test01', status: 'failed', exitKind: 'failed' },
    ])
    // 取走后再取为空，句柄补投位置 true
    expect(consumeUndeliveredTerminalTasks()).toEqual([])
    expect(getTaskHandleRecord('a1test01')?.notified).toBe(true)

    await _flushTaskRegistrySnapshotsForTest()
    const onDisk = JSON.parse(
      await readFile(getTaskSnapshotPath('a1test01'), 'utf8'),
    )
    expect(onDisk.notified).toBe(true)
    expect(onDisk.status).toBe('failed')
    // 存活句柄不受影响
    expect(getTaskHandleRecord('b2test02')?.notified).toBe(false)
    expect(getTaskHandleRecord('b2test02')?.status).toBe('running')
  })

  test('压置 notified 的句柄不出现在补投面（kill 静默路）', () => {
    recordTaskHandle({
      id: 'b3stop01',
      type: 'local_bash',
      status: 'killed',
      exitKind: 'killed',
      notified: true,
      updatedAt: 7,
    })
    expect(peekUndeliveredTerminalTasks()).toEqual([])
    expect(consumeUndeliveredTerminalTasks()).toEqual([])
  })
})

describe('taskRegistry — reaper', () => {
  test('running 超时无增量 → 疑似名单（不改 status）+ 挂 diagnostics', () => {
    const t0 = 1_700_000_000_000
    recordTaskHandle({
      id: 'b4zap01',
      type: 'local_bash',
      status: 'running',
      description: 'silent monitor',
      startedAt: t0,
      updatedAt: t0,
    })
    recordTaskHandle({
      id: 'a5zap02',
      type: 'local_agent',
      status: 'running',
      description: 'fresh agent',
      startedAt: t0,
      updatedAt: t0 + 4000,
    })
    recordTaskHandle({
      id: 'b6done03',
      type: 'local_bash',
      status: 'completed',
      updatedAt: t0,
    })

    // 超时阈值 5000ms，现在为 t0+8000：
    // b4zap01 静默 8000 → 疑似；a5zap02 静默 4000 → 正常；b6done03 已终态不管。
    const suspicious = reapSuspiciousTasks(5000, t0 + 8000)
    expect(suspicious).toEqual([
      {
        id: 'b4zap01',
        type: 'local_bash',
        description: 'silent monitor',
        updatedAt: t0,
        silenceMs: 8000,
      },
    ])
    // reaper 不改 status（裁决权在调用方）
    expect(getTaskHandleRecord('b4zap01')?.status).toBe('running')

    // 名单挂 diagnostics（lastReap）
    expect(getTaskRegistryDiagnostics().lastReap).toEqual({
      at: t0 + 8000,
      maxSilenceMs: 5000,
      suspicious,
    })
  })

  test('心跳（增量）解除疑似；未知/非运行句柄心跳 no-op', () => {
    const t0 = 1_700_000_000_000
    recordTaskHandle({
      id: 'b7hb001',
      type: 'local_bash',
      status: 'running',
      updatedAt: t0,
    })
    recordTaskHandle({
      id: 'b8hb002',
      type: 'local_bash',
      status: 'completed',
      updatedAt: t0,
    })

    recordTaskHeartbeats(['b7hb001', 'b8hb002', 'unknown99'], t0 + 3000)
    expect(getTaskHandleRecord('b7hb001')?.updatedAt).toBe(t0 + 3000)
    // 非运行句柄与未知句柄不 upsert
    expect(getTaskHandleRecord('b8hb002')?.updatedAt).toBe(t0)
    expect(getTaskHandleRecord('unknown99')).toBeUndefined()

    // 静默 1000 ≤ 阈值 1000 → 不疑似
    expect(reapSuspiciousTasks(1000, t0 + 4000)).toEqual([])
  })

  test('recordTaskHeartbeat 单发：运行中句柄 updatedAt 前推且单调', () => {
    const t0 = 1_700_000_000_000
    recordTaskHandle({
      id: 'a9hb003',
      type: 'local_agent',
      status: 'running',
      updatedAt: t0,
    })
    recordTaskHeartbeat('a9hb003', t0 + 100)
    recordTaskHeartbeat('a9hb003', t0 + 50) // 回拨时钟不回退
    expect(getTaskHandleRecord('a9hb003')?.updatedAt).toBe(t0 + 100)
  })
})

describe('taskRegistry — 写失败不抛', () => {
  test('CLAUDE_CONFIG_DIR 指向文件（ENOTDIR）时内存表照常工作，console.debug 兜底', async () => {
    const blockFile = join(tempDir, 'not-a-dir')
    await writeFile(blockFile, 'this is a file, not a config dir')
    process.env.CLAUDE_CONFIG_DIR = blockFile

    const debugSpy = spyOn(console, 'debug')
    try {
      expect(() =>
        recordTaskHandle({
          id: 'b9boom01',
          type: 'local_bash',
          status: 'running',
          description: 'doomed snapshot',
          updatedAt: 5,
        }),
      ).not.toThrow()

      // 状态迁移照常（内存），死讯面照常
      recordTaskHandle({
        id: 'b9boom01',
        type: 'local_bash',
        status: 'failed',
        exitKind: 'failed',
        updatedAt: 9,
      })
      expect(getAllTaskHandleRecords()).toHaveLength(1)
      expect(consumeUndeliveredTerminalTasks()).toEqual([
        { id: 'b9boom01', status: 'failed', exitKind: 'failed' },
      ])

      // 等写链消化完：只 catch 兜底，不冒 unhandled rejection
      await _flushTaskRegistrySnapshotsForTest()
      expect(
        debugSpy.mock.calls.some(call =>
          String(call[0]).includes('taskRegistry'),
        ),
      ).toBe(true)
      // 快照确实没写出来（目录不可建）
      await expect(stat(getTaskSnapshotPath('b9boom01'))).rejects.toThrow()
    } finally {
      debugSpy.mockRestore()
    }
  })
})
