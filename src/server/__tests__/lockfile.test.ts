import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'

import {
  probeRunningServer,
  removeServerLock,
  serverLockPath,
  writeServerLock,
} from '../lockfile.js'

let tmpDir: string
const oldConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cch-lockfile-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterAll(() => {
  process.env.CLAUDE_CONFIG_DIR = oldConfigDir
  void rm(tmpDir, { recursive: true, force: true })
})

describe('serverLockPath', () => {
  test('places server.lock under CLAUDE_CONFIG_DIR', () => {
    expect(serverLockPath()).toBe(path.join(tmpDir, 'server.lock'))
  })
})

describe('writeServerLock / removeServerLock', () => {
  test('writes JSON lock content and removes it', async () => {
    const info = {
      pid: process.pid,
      port: 45678,
      host: '127.0.0.1',
      httpUrl: 'http://127.0.0.1:45678',
      startedAt: Date.now(),
    }
    await writeServerLock(info)
    const raw = JSON.parse(await readFile(serverLockPath(), 'utf8')) as {
      pid: number
      port: number
    }
    expect(raw.pid).toBe(process.pid)
    expect(raw.port).toBe(45678)

    await removeServerLock()
    expect(await probeRunningServer()).toBeNull()
  })
})

describe('probeRunningServer', () => {
  test('returns null and clears the lock for a dead pid', async () => {
    // PID 2^22-ish is virtually never a live user process we own; probe the
    // liveness assumption first so the test stays deterministic.
    const deadPid = 4000000 + (process.pid % 1000)
    try {
      process.kill(deadPid, 0)
      return // accidentally alive — skip the negative case
    } catch {
      // expected: no such process
    }
    await writeServerLock({
      pid: deadPid,
      port: 1,
      host: '127.0.0.1',
      httpUrl: 'http://127.0.0.1:1',
      startedAt: Date.now(),
    })
    expect(await probeRunningServer()).toBeNull()
    expect(
      await readFile(serverLockPath(), 'utf8').catch(() => null),
    ).toBeNull()
  })

  test('conservatively reports a live pid as running even when /health is unreachable', async () => {
    await writeServerLock({
      pid: process.pid, // this test process is alive
      port: 1,
      host: '127.0.0.1',
      httpUrl: 'http://127.0.0.1:1', // nothing listens here
      startedAt: Date.now(),
    })
    const found = await probeRunningServer()
    expect(found?.pid).toBe(process.pid)
    await removeServerLock()
  })

  test('treats a corrupt lock as stale and removes it', async () => {
    writeFileSync(serverLockPath(), '{not json at all')
    expect(await probeRunningServer()).toBeNull()
    expect(
      await readFile(serverLockPath(), 'utf8').catch(() => null),
    ).toBeNull()
  })
})
