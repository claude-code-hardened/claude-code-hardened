/**
 * Tests for src/services/taskRegistry/taskRegistry.ts — CCH #38 中央任务
 * 句柄注册表（官方忠实还原：docs/reverse-284/decompiled/
 * 0001-chunk-xrzcaagk/module-006-uncategorized.js:8420 `g.taskRegistry=n`
 * 进程内活表 / :8428 `$M` 对 !h.notified 补投一次；0002-chunk-zrkp23rq/
 * module-005-uncategorized.js:3417 起的 handle 渲染面 status/notified/
 * quietlyParked；0001:1919/2116/2186 的 task-notification 队列 origin 语义
 * —— 句柄表为本体，通知只是视图）。
 *
 * CCH 审查修复 Round 回归官方进程内语义：磁盘快照层（落盘 + hydrate 回放）
 * 整体退役，留下的问题类（陈年回放/僵尸 running/写竞态/GC）由构造消除。
 *
 * 覆盖：状态迁移（内存）/ 死讯补投取走置位 / reaper 超时判定 /
 * 进程死亡即表清空（无启动回放）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetTaskRegistryForTest,
  deliverOnResume,
  getAllTaskHandleRecords,
  getTaskHandleRecord,
  getTaskRegistryDiagnostics,
  peekUndeliveredTerminalTasks,
  reapSuspiciousTasks,
  recordTaskHandle,
  recordTaskHeartbeat,
  recordTaskHeartbeats,
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
  // 指向一个（将要创建的）目录，隔离测试期间的注册表环境变量。
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

describe('taskRegistry — 状态迁移（进程内活表）', () => {
  test('spawn 建 running 句柄，终态迁移补 exitKind', () => {
    const t0 = 1_700_000_000_000
    recordTaskHandle({
      id: 'b1test01',
      type: 'local_bash',
      status: 'running',
      description: 'long build',
      startedAt: t0,
      updatedAt: t0,
    })

    const spawned = getTaskHandleRecord('b1test01')
    expect(spawned).toMatchObject({
      id: 'b1test01',
      type: 'local_bash',
      status: 'running',
      notified: false,
      description: 'long build',
      startedAt: t0,
      updatedAt: t0,
    })

    // 状态迁移：running → completed（exitKind 缺省按 status 补）
    const terminal = recordTaskHandle({
      id: 'b1test01',
      type: 'local_bash',
      status: 'completed',
      updatedAt: t0 + 5000,
    })
    expect(terminal.status).toBe('completed')
    expect(terminal.exitKind).toBe('completed')
    expect(terminal.updatedAt).toBe(t0 + 5000)
    expect(terminal.startedAt).toBe(t0)
    expect(getAllTaskHandleRecords()).toHaveLength(1)
  })

  test('终态句柄不接受非终态回迁（迟到写不能诈尸）', () => {
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
  })

  test('quietlyParked 终态句柄直接视为已送达（官方 parked 挂表语义）', () => {
    recordTaskHandle({
      id: 'a8park01',
      type: 'local_agent',
      status: 'completed',
      quietlyParked: true,
      updatedAt: 42,
    })
    expect(getTaskHandleRecord('a8park01')?.notified).toBe(true)
    expect(peekUndeliveredTerminalTasks()).toEqual([])
  })
})

describe('taskRegistry — 死讯面（官方 $M !h.notified 的只读观察）', () => {
  test('终态且 notified=false 的清单按 id/type/status 透出（含 exitKind）', () => {
    const t0 = 1_700_000_000_000
    recordTaskHandle({
      id: 'a1test01',
      type: 'local_agent',
      status: 'failed',
      exitKind: 'failed',
      description: 'lost agent',
      updatedAt: t0,
    })
    expect(peekUndeliveredTerminalTasks()).toEqual([
      {
        id: 'a1test01',
        type: 'local_agent',
        status: 'failed',
        exitKind: 'failed',
      },
    ])
    // 只读：peek 不置位
    expect(getTaskHandleRecord('a1test01')?.notified).toBe(false)

    // 诊断构建面看到同一清单
    expect(getTaskRegistryDiagnostics().undelivered).toEqual([
      {
        id: 'a1test01',
        type: 'local_agent',
        status: 'failed',
        exitKind: 'failed',
      },
    ])
  })

  test('压置 notified 的句柄不出现在未投面（正常送达/kill 静默路）', () => {
    recordTaskHandle({
      id: 'a2silent1',
      type: 'local_agent',
      status: 'killed',
      exitKind: 'killed',
      notified: true,
    })
    expect(peekUndeliveredTerminalTasks()).toEqual([])
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

// ─── CCH 审查修复 Round：回归官方进程内语义（落盘扩展整体删除） ──────────────

describe('taskRegistry — 新会话启动零回放（官方 :8420 表随 session 消亡）', () => {
  test('进程死亡 = 表清空：重建后死讯不补投、无任何启动回放', () => {
    const t0 = 1_700_000_000_000
    recordTaskHandle({
      id: 'abghost1',
      type: 'local_agent',
      status: 'failed',
      exitKind: 'failed',
      updatedAt: t0,
    })
    expect(peekUndeliveredTerminalTasks()).toHaveLength(1)
    // 模拟进程重启（内存表清空）—— 官方语义下该句柄及其死讯随旧进程消亡，
    // 新进程不做任何回放（陈年通知回放类缺陷由构造消除）。
    return _resetTaskRegistryForTest().then(() => {
      expect(peekUndeliveredTerminalTasks()).toEqual([])
      expect(getTaskHandleRecord('abghost1')).toBeUndefined()
      expect(getTaskRegistryDiagnostics().handles).toEqual([])
    })
  })
})

describe('taskRegistry — deliverOnResume：resume 咽喉单点补投（官方 :8428 $M 形态）', () => {
  test('!notified 终态句柄：取走置位并返回尸讯记录（含描述/输出文件/终态成因）', () => {
    const t0 = 1_700_000_000_000
    recordTaskHandle({
      id: 'abresum01',
      type: 'local_agent',
      status: 'killed',
      exitKind: 'killed',
      description: 'stopped scout',
      outputFile: '/tmp/agent-output/abresum01.txt',
      updatedAt: t0,
    })

    const corpse = deliverOnResume('abresum01')
    expect(corpse).toMatchObject({
      id: 'abresum01',
      type: 'local_agent',
      status: 'killed',
      exitKind: 'killed',
      description: 'stopped scout',
      outputFile: '/tmp/agent-output/abresum01.txt',
      notified: true,
    })
    // 单点结清：同一句柄二次取走为空
    expect(deliverOnResume('abresum01')).toBeUndefined()
    expect(peekUndeliveredTerminalTasks()).toEqual([])
  })

  test('单点而非全局：其它未投句柄不被连带广播/置位', () => {
    recordTaskHandle({
      id: 'abresum02',
      type: 'local_agent',
      status: 'failed',
      exitKind: 'failed',
      description: 'should stay parked',
      updatedAt: Date.now(),
    })
    recordTaskHandle({
      id: 'abresum03',
      type: 'local_agent',
      status: 'failed',
      exitKind: 'failed',
      description: 'other corpse',
      updatedAt: Date.now(),
    })

    // 显式 resume 只作用于 abresum02 这一个 taskId
    expect(deliverOnResume('abresum02')).toMatchObject({ id: 'abresum02' })
    // abresum03 保持 !notified、仍在未投面（官方 $M 无目录扫描/全局补投）
    expect(getTaskHandleRecord('abresum03')?.notified).toBe(false)
    expect(peekUndeliveredTerminalTasks().map(t => t.id)).toEqual(['abresum03'])
  })

  test('已投/非终态/未知句柄 no-op（官方 $M 只对 !h.notified 面动作）', () => {
    recordTaskHandle({
      id: 'abresum04',
      type: 'local_agent',
      status: 'completed',
      exitKind: 'completed',
      notified: true,
      updatedAt: Date.now(),
    })
    recordTaskHandle({
      id: 'abresum05',
      type: 'local_agent',
      status: 'running',
      updatedAt: Date.now(),
    })
    expect(deliverOnResume('abresum04')).toBeUndefined()
    expect(deliverOnResume('abresum05')).toBeUndefined()
    expect(deliverOnResume('abresum-unknown')).toBeUndefined()
    expect(getTaskHandleRecord('abresum05')?.notified).toBe(false)
  })
})
