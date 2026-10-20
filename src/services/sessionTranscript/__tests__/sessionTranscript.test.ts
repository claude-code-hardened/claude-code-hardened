import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

// Shared mocks first — log.ts/debug.ts have module-level side effects
// (see CLAUDE.md mock rules) and are reachable via sessionStorage.
// logError is wired to a capture array so tests can assert the
// production-visible failure path (replaces the old console.debug-only
// channel).
const logErrorCalls: unknown[] = []
mock.module('src/utils/log.ts', () => ({
  ...logMock(),
  logError: (error: unknown) => {
    logErrorCalls.push(error)
  },
}))
mock.module('src/utils/debug.ts', debugMock)

// bootstrap/state.ts reads module-level STATE at call time; mocking the
// getters keeps segment files inside a temp dir instead of the real
// ~/.claude/projects layout. Partial spread keeps every other export real.
import * as actualState from '../../../bootstrap/state.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'kairos-seg-'))
let projectDirOverride = join(tmpRoot, 'projects', 'proj-a')
const SESSION_ID = 'kairos-seg-test'

mock.module('src/bootstrap/state.ts', () => ({
  ...actualState,
  getSessionId: () => SESSION_ID,
  getSessionProjectDir: () => projectDirOverride,
  getOriginalCwd: () => tmpRoot,
}))

const { writeSessionTranscriptSegment, flushOnDateChange, getSegmentFilePath } =
  await import('../sessionTranscript.js')

import type { Message } from '../../../../src/types/message.js'

function makeMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    uuid: `u-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  } as unknown as Message
}

// Local-date bucket for a given Date — mirrors localISODate() in the module.
function bucketOf(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

const createdDirs: string[] = []
afterAll(() => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

beforeEach(() => {
  mkdirSync(projectDirOverride, { recursive: true })
  createdDirs.push(projectDirOverride)
})

describe('writeSessionTranscriptSegment', () => {
  test('appends messages as JSONL lines under the session-storage layout', async () => {
    const msgA = makeMessage({ type: 'user' })
    const msgB = makeMessage({ type: 'assistant' })
    await writeSessionTranscriptSegment([msgA, msgB])

    const path = getSegmentFilePath(bucketOf(new Date()))
    expect(existsSync(path)).toBe(true)

    const lines = readLines(path)
    expect(lines).toHaveLength(2)

    const first = lines[0]
    // Official /share envelope field names (docs/reverse-284):
    expect(first['trigger']).toBe('compact')
    expect(first['platform']).toBe(process.platform)
    expect(first['commitSha']).toBeNull()
    expect(typeof first['version']).toBe('string')
    // Local superset fields:
    expect(first['sessionId']).toBe(SESSION_ID)
    expect(first['date']).toBe(bucketOf(new Date()))
    expect(typeof first['ts']).toBe('string')
    // Message serialized verbatim under the official `transcript` field:
    expect(first['transcript']).toEqual(msgA)
    expect(lines[1]!['transcript']).toEqual(msgB)
  })

  test('re-buckets messages into per-day files on a date change', async () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const staleTimestamp = new Date(
      yesterday.getFullYear(),
      yesterday.getMonth(),
      yesterday.getDate(),
      12,
    ).toISOString()
    const yesterdayBucket = bucketOf(yesterday)
    const todayBucket = bucketOf(new Date())

    const staleMsg = makeMessage({ timestamp: staleTimestamp })
    const undatedMsg = makeMessage({ timestamp: undefined })
    await writeSessionTranscriptSegment([staleMsg, undatedMsg], 'date_change')

    // Timestamped message lands in its own day's file, flagged as a flush.
    const yesterdayPath = getSegmentFilePath(yesterdayBucket)
    expect(existsSync(yesterdayPath)).toBe(true)
    const yesterdayLines = readLines(yesterdayPath)
    expect(yesterdayLines).toHaveLength(1)
    expect(yesterdayLines[0]!['transcript']).toEqual(staleMsg)
    expect(yesterdayLines[0]!['trigger']).toBe('date_change')
    expect(yesterdayLines[0]!['date']).toBe(yesterdayBucket)

    // Undated message buckets under the flush-time local date.
    const todayPath = getSegmentFilePath(todayBucket)
    const todayLines = readLines(todayPath)
    expect(todayLines.length).toBeGreaterThanOrEqual(1)
    const undatedLine = todayLines.find(
      line => JSON.stringify(line['transcript']) === JSON.stringify(undatedMsg),
    )
    expect(undatedLine).toBeDefined()
    expect(undatedLine!['trigger']).toBe('date_change')

    // flushOnDateChange: same bucketing, fire-and-forget (never throws).
    projectDirOverride = join(tmpRoot, 'projects', 'proj-b')
    mkdirSync(projectDirOverride, { recursive: true })
    flushOnDateChange([makeMessage({ timestamp: staleTimestamp })], todayBucket)
    await new Promise(resolve => setTimeout(resolve, 100))
    const flushedLines = readLines(getSegmentFilePath(yesterdayBucket))
    expect(flushedLines.at(-1)!['trigger']).toBe('date_change')
  })

  test('skips a single unserializable message and still writes the rest of the batch', async () => {
    // Regression: JSON.stringify used to run OUTSIDE any try, so one
    // unserializable Message (circular ref / BigInt) rejected the whole
    // promise — with compact.ts's bare `void` call that surfaced as an
    // unhandled rejection and every other message in the batch was lost.
    projectDirOverride = join(tmpRoot, 'projects', 'proj-badmsg')
    mkdirSync(projectDirOverride, { recursive: true })
    createdDirs.push(projectDirOverride)

    const goodA = makeMessage()
    const goodB = makeMessage()
    const circular: Record<string, unknown> = { type: 'user' }
    circular.self = circular // JSON.stringify throws on circular structure

    const result = await writeSessionTranscriptSegment([
      goodA,
      circular as unknown as Message,
      goodB,
    ])
    expect(result).toBeUndefined()

    const path = getSegmentFilePath(bucketOf(new Date()))
    const lines = readLines(path)
    const serialized = lines.map(l => JSON.stringify(l['transcript']))
    expect(serialized).toContain(JSON.stringify(goodA))
    expect(serialized).toContain(JSON.stringify(goodB))
    expect(lines).toHaveLength(2)
    // Failure is production-visible via logError (module is mocked here —
    // capture array asserts the call happened).
    expect(logErrorCalls.length).toBeGreaterThan(0)
    logErrorCalls.length = 0
  })

  test('never throws when the write fails — surfaced via logError, not console.debug', async () => {
    // Point the project dir at a plain FILE: mkdir/append under it fails
    // with ENOTDIR, exercising the swallow-and-log path.
    const notADir = join(tmpRoot, 'not-a-dir-blocker')
    writeFileSync(notADir, 'blocked', 'utf8')
    projectDirOverride = notADir
    createdDirs.push(notADir)

    try {
      await expect(
        writeSessionTranscriptSegment([makeMessage()]),
      ).resolves.toBeUndefined()
      // flushOnDateChange wraps the same call — sync non-throw too.
      expect(() =>
        flushOnDateChange([makeMessage()], bucketOf(new Date())),
      ).not.toThrow()
      await new Promise(resolve => setTimeout(resolve, 100))
      // Failure surfaced through the production log channel.
      expect(logErrorCalls.length).toBeGreaterThan(0)
    } finally {
      logErrorCalls.length = 0
    }
  })
})
