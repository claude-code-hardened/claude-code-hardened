import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const debugMock = {
  isDebugMode: () => false,
  logForDebugging: () => {},
}

mock.module('src/utils/debug.ts', () => debugMock)

const testRoot = join(tmpdir(), `ccb-memsampler-test-${process.pid}`)
let holderValue = 7

mock.module('src/bootstrap/state.js', () => ({
  getSessionId: () => 'test-session',
}))

mock.module('src/utils/envUtils.ts', () => ({
  getClaudeConfigHomeDir: () => testRoot,
  isEnvTruthy: () => false,
}))

// eslint-disable-next-line import/first
import {
  markMemory,
  registerMemoryHolder,
  startDebugMemorySampler,
} from '../debugMemorySampler.js'

type SampleRecord = Record<string, unknown> & { event: string }

function readSamples(): SampleRecord[] {
  return readFileSync(
    join(testRoot, 'debug', 'memory-test-session.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as SampleRecord)
}

describe('debugMemorySampler', () => {
  beforeEach(() => {
    mkdirSync(join(testRoot, 'debug'), { recursive: true })
    holderValue = 7
  })

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true })
    delete process.env.CCB_HEAP_SNAPSHOT_MB
  })

  test('writes a sample immediately on start', () => {
    startDebugMemorySampler(() => 3)
    const samples = readSamples()
    expect(samples.length).toBe(1)
    expect(samples[0]?.event).toBe('sample')
    expect(samples[0]?.rssMb).toBeGreaterThan(0)
    expect(samples[0]?.msgs).toBe(3)
  })

  test('markMemory writes a labeled record', () => {
    startDebugMemorySampler(() => 0)
    markMemory('turn_end')
    const samples = readSamples()
    const mark = samples.find((s) => s.event === 'mark')
    expect(mark?.label).toBe('turn_end')
    expect(mark?.rssMb).toBeGreaterThan(0)
  })

  test('registered holders appear in samples', () => {
    registerMemoryHolder('windowedCache', () => holderValue)
    startDebugMemorySampler(() => 0)
    const samples = readSamples()
    expect(samples[0]?.holders).toEqual({ windowedCache: 7 })
  })

  test('dumps heap snapshot once when RSS crosses threshold', () => {
    process.env.CCB_HEAP_SNAPSHOT_MB = '0.001'
    startDebugMemorySampler(() => 0)
    markMemory('force-tick')
    const samples = readSamples()
    const snapshots = samples.filter((s) => s.event === 'heap_snapshot')
    expect(snapshots.length).toBe(1)
    const path = snapshots[0]?.path as string
    expect(path).toContain('.heapsnapshot')
    expect(path).toContain('MB.heapsnapshot')
  })
})
