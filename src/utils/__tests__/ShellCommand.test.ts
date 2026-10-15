import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { debugMock } from '../../../tests/mocks/debug'
import { logMock } from '../../../tests/mocks/log'
import { stateMock } from '../../../tests/mocks/state'

const treeKillCalls: Array<{ pid: number; signal: string }> = []

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/bootstrap/state.js', stateMock)
mock.module('tree-kill', () => ({
  default: (
    pid: number,
    signal?: string,
    callback?: (error?: Error) => void,
  ) => {
    treeKillCalls.push({ pid, signal: signal ?? 'SIGTERM' })
    callback?.(undefined)
  },
}))

// Import after mocks are registered.
const { wrapSpawn } = await import('src/utils/ShellCommand.js')

type TaskOutputStub = {
  getStdout: () => Promise<string>
  getStderr: () => string
  path: string
  stdoutToFile: boolean
  outputFileRedundant: boolean
  clear: () => void
  deleteOutputFile: () => Promise<void>
  spillToDisk: () => void
}

/** Minimal TaskOutput stand-in; ShellCommand only reads from it. */
function makeStubTaskOutput(): TaskOutputStub {
  return {
    getStdout: async () => '',
    getStderr: () => '',
    path: '/tmp/claude-shellcommand-test-output',
    stdoutToFile: false,
    outputFileRedundant: false,
    clear: () => {},
    deleteOutputFile: async () => {},
    spillToDisk: () => {},
  }
}

/** Event-emitting fake child process with an optional spoofed pid. */
function makeFakeChild(pid?: number): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  if (pid !== undefined) {
    ;(child as ChildProcess & { pid?: number }).pid = pid
  }
  return child
}

function makeShellCommand(
  child: ChildProcess,
  timeoutMs: number,
): ReturnType<typeof wrapSpawn> {
  return wrapSpawn(
    child,
    new AbortController().signal,
    timeoutMs,
    makeStubTaskOutput() as unknown as Parameters<typeof wrapSpawn>[3],
  )
}

describe('ShellCommand #doKill', () => {
  beforeEach(() => {
    treeKillCalls.length = 0
  })

  test('timeout sends SIGTERM first, then SIGKILL after the 400ms grace window', async () => {
    const child = makeFakeChild(42_000)
    const shellCommand = makeShellCommand(child, 10)
    const resultPromise = shellCommand.result

    await Bun.sleep(50)
    // Stage 1 only — no immediate SIGKILL storm.
    expect(treeKillCalls).toEqual([{ pid: 42_000, signal: 'SIGTERM' }])

    await Bun.sleep(450)
    expect(treeKillCalls).toEqual([
      { pid: 42_000, signal: 'SIGTERM' },
      { pid: 42_000, signal: 'SIGKILL' },
    ])

    const result = await resultPromise
    expect(result.code).toBe(137) // 128 + SIGKILL
    expect(result.timeoutLabel).toBe('timed_out_force')
    expect(result.stderr).toContain('Command timed out after')
    expect(result.stderr).toContain('escalated to SIGKILL')
    // A forced timeout kill is not a user interruption.
    expect(result.interrupted).toBe(false)
  })

  test('process that exits on SIGTERM is labeled timed_out with its real exit code, no escalation', async () => {
    const child = makeFakeChild(43_000)
    const shellCommand = makeShellCommand(child, 10)
    const resultPromise = shellCommand.result

    await Bun.sleep(30)
    expect(treeKillCalls.map(call => call.signal)).toEqual(['SIGTERM'])

    // Shell honors SIGTERM: exits with 128 + 15. No fake SIGKILL push should
    // ever be recorded, even after the grace window elapses.
    child.emit('exit', 143, 'SIGTERM')

    const result = await resultPromise
    expect(result.code).toBe(143)
    expect(result.timeoutLabel).toBe('timed_out')
    expect(result.stderr).toContain('Command timed out after')
    expect(result.stderr).not.toContain('SIGKILL')

    await Bun.sleep(450)
    expect(treeKillCalls.map(call => call.signal)).toEqual(['SIGTERM'])
  })

  test('external SIGKILL exit maps null code to 137', async () => {
    const child = makeFakeChild(44_000)
    const shellCommand = makeShellCommand(child, 60_000)
    const resultPromise = shellCommand.result

    child.emit('exit', null, 'SIGKILL')

    const result = await resultPromise
    expect(result.code).toBe(137)
  })

  test('kill() force-kills with SIGKILL immediately and reports interrupted', async () => {
    const child = makeFakeChild(45_000)
    const shellCommand = makeShellCommand(child, 60_000)
    const resultPromise = shellCommand.result

    await Bun.sleep(5)
    shellCommand.kill()
    expect(treeKillCalls).toEqual([{ pid: 45_000, signal: 'SIGKILL' }])

    const result = await resultPromise
    expect(result.code).toBe(137)
    expect(result.interrupted).toBe(true)
    expect(result.timeoutLabel).toBeUndefined()
  })

  test('kill() with no pid resolves immediately without signaling', async () => {
    const child = makeFakeChild(undefined)
    const shellCommand = makeShellCommand(child, 60_000)
    const resultPromise = shellCommand.result

    shellCommand.kill()

    const result = await resultPromise
    expect(result.code).toBe(137)
    expect(result.interrupted).toBe(true)
    expect(treeKillCalls).toEqual([])
  })
})
