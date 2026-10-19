/**
 * Tests for CCH #52/#4 unpark 语义收敛（Q2 W1.4）。
 *
 * 官方真源 docs/reverse-284/0001-chunk-xrzcaagk/module-006-uncategorized.js
 * :8428 `$M` resume 落点原文：
 *   `g.quietlyParked===!0 → n.update(e,(U)=>({...U,notified:!1,
 *     quietlyParked:!1}))`
 * —— unpark **仅**在既有句柄 quietlyParked===true 时双清 parked/notified，
 * **不改 status**（$M 复活通知路从不重开句柄）。上一版顺带把冻结终态重开
 * 为 running 的 allowReopen 是超宽面，已退役；resume 需要运行中句柄的面
 * 另走 reopenRunning 显式路径（同样只属 resume 接线，非 $M 语义）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _flushTaskRegistrySnapshotsForTest,
  _resetTaskRegistryForTest,
  getTaskHandleRecord,
  recordTaskHandle,
} from '../taskRegistry.js'

let tempDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  tempDir = join(
    tmpdir(),
    `task-registry-unpark-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  await mkdir(tempDir, { recursive: true })
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

describe('recordTaskHandle unpark（官方 $M 静默清停，不碰 status）', () => {
  test('unpark 仅在 quietlyParked===true 时清 parked/notified，status 不改', () => {
    // 静默批量 kill → 终态 + parked 挂表（markAgentsNotified 落法）
    recordTaskHandle({
      id: 'b9parked1',
      type: 'local_agent',
      status: 'killed',
      description: 'scout',
      quietlyParked: true,
    })
    const parked = getTaskHandleRecord('b9parked1')
    expect(parked?.status).toBe('killed')
    expect(parked?.quietlyParked).toBe(true)
    expect(parked?.notified).toBe(true)

    // $M unpark：{notified:!1, quietlyParked:!1}，status 保持 killed
    const record = recordTaskHandle({
      id: 'b9parked1',
      type: 'local_agent',
      status: 'killed',
      description: 'scout',
      unpark: true,
    })
    expect(record.status).toBe('killed')
    expect(record.quietlyParked).toBe(false)
    expect(record.notified).toBe(false)
    // 终态成因仍见证最近一次终态（句柄未被重开）
    expect(record.exitKind).toBe('killed')
  })

  test('unpark 非 parked 句柄为 no-op（原文 g.quietlyParked===!0 前置）', () => {
    recordTaskHandle({
      id: 'c1done001',
      type: 'local_agent',
      status: 'completed',
      description: 'builder',
    })
    // 未挂表的 completed 句柄：unpark 不清位（notified 保留既有值）
    const record = recordTaskHandle({
      id: 'c1done001',
      type: 'local_agent',
      status: 'completed',
      description: 'builder',
      unpark: true,
    })
    expect(record.status).toBe('completed')
    expect(record.quietlyParked).toBeFalsy()
    expect(record.notified).toBe(false)
  })

  test('unpark 也不能重开冻结终态（重开走 reopenRunning 显式路径）', () => {
    recordTaskHandle({
      id: 'd2frozen1',
      type: 'local_agent',
      status: 'completed',
      description: 'builder',
      quietlyParked: true,
    })
    const record = recordTaskHandle({
      id: 'd2frozen1',
      type: 'local_agent',
      status: 'running',
      description: 'builder',
      unpark: true,
    })
    // unpark：parked/notified 双清，但 status 冻结在 completed（迟到写
    // 不能诈尸；$M 复活通知路从不改 status）
    expect(record.status).toBe('completed')
    expect(record.quietlyParked).toBe(false)
    expect(record.notified).toBe(false)
  })

  test('reopenRunning 显式重开冻结句柄为 running（resume 接线面）', () => {
    recordTaskHandle({
      id: 'd3reopen1',
      type: 'local_agent',
      status: 'killed',
      description: 'scout',
      quietlyParked: true,
    })
    const reopened = recordTaskHandle({
      id: 'd3reopen1',
      type: 'local_agent',
      status: 'running',
      description: 'scout',
      reopenRunning: true,
    })
    expect(reopened.status).toBe('running')
    expect(reopened.quietlyParked).toBe(false)
    expect(reopened.notified).toBe(false)
    // exitKind 不见证复活（句柄不再是终态）
    expect(reopened.exitKind).toBeUndefined()

    // 未带 reopenRunning 的迟到 running 写仍被冻结（终态已完成新的冻结）
    recordTaskHandle({
      id: 'd3reopen1',
      type: 'local_agent',
      status: 'failed',
      exitKind: 'failed',
    })
    const refrozen = recordTaskHandle({
      id: 'd3reopen1',
      type: 'local_agent',
      status: 'running',
    })
    expect(refrozen.status).toBe('failed')
  })

  test('reopenRunning 后正常收尾可再次落终态（复活句柄完整生命周期）', async () => {
    recordTaskHandle({
      id: 'e3relife1',
      type: 'local_agent',
      status: 'killed',
      quietlyParked: true,
    })
    recordTaskHandle({
      id: 'e3relife1',
      type: 'local_agent',
      status: 'running',
      description: 'relife',
      reopenRunning: true,
    })
    const terminal = recordTaskHandle({
      id: 'e3relife1',
      type: 'local_agent',
      status: 'completed',
      exitKind: 'completed',
    })
    expect(terminal.status).toBe('completed')
    expect(terminal.exitKind).toBe('completed')
    // 复活后的新一轮死讯从 notified=false 重新计数（补投面可达）
    expect(terminal.notified).toBe(false)
    await _flushTaskRegistrySnapshotsForTest()
  })
})
