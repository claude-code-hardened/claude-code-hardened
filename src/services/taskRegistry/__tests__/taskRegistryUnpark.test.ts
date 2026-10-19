/**
 * Tests for CCH #52/#4 unpark（官方 $M 复活位）：recordTaskHandle 的
 * input.unpark?:true 显式清除 quietlyParked 并重开冻结的终态句柄。
 *
 * 官方真源 docs/reverse-284/0001-chunk-xrzcaagk/module-006-uncategorized.js
 * `$M`：resume 落点 `quietlyParked===true → {notified:false, quietlyParked:false}`。
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

describe('recordTaskHandle unpark（官方 $M 复活位）', () => {
  test('unpark 重开冻结的 quietlyParked 终态句柄为 running 并清 parked/notified', () => {
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

    // 复活（unpark: true）→ 句柄重开为 running，parked/notified 双清
    const reopened = recordTaskHandle({
      id: 'b9parked1',
      type: 'local_agent',
      status: 'running',
      description: 'scout',
      unpark: true,
    })
    expect(reopened.status).toBe('running')
    expect(reopened.quietlyParked).toBe(false)
    expect(reopened.notified).toBe(false)
    // exitKind 不见证复活（句柄不再是终态）
    expect(reopened.exitKind).toBeUndefined()
  })

  test('unpark 在同状态元数据写入时仅清 parked（不重置 notified）', () => {
    recordTaskHandle({
      id: 'c1done001',
      type: 'local_agent',
      status: 'completed',
      description: 'builder',
      quietlyParked: true,
    })
    // 同为 completed 的元数据写入（非复活）：parked 清除，冻结不触发
    const record = recordTaskHandle({
      id: 'c1done001',
      type: 'local_agent',
      status: 'completed',
      description: 'builder',
      unpark: true,
    })
    expect(record.status).toBe('completed')
    expect(record.quietlyParked).toBe(false)
    expect(record.notified).toBe(true)
  })

  test('无 unpark 时终态冻结保持现状（迟到写不能诈尸）', () => {
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
    })
    // 无 unpark：status 冻结在 completed，parked 位保留
    expect(record.status).toBe('completed')
    expect(record.quietlyParked).toBe(true)
  })

  test('unpark 后正常收尾可再次落终态（复活句柄完整生命周期）', async () => {
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
      unpark: true,
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
