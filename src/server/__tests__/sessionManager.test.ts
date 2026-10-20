import { describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'

import type {
  DangerousBackend,
  SpawnCommand,
} from '../backends/dangerousBackend.js'
import { SessionManager } from '../sessionManager.js'

/** Structural backend stub: spawn whatever the test asks for. */
function fakeBackend(spawn: SpawnCommand): DangerousBackend {
  return {
    name: 'test-stub',
    buildSpawnCommand: () => spawn,
    transformInboundMessage: (message: string) => message,
  } as unknown as DangerousBackend
}

const bunScript = (code: string): SpawnCommand => ({
  command: process.execPath,
  args: ['-e', code],
  env: { ...process.env },
})

type SessionRegistry = Map<
  string,
  { info: { process: ChildProcess | null; status: string }; stoppedAt?: number }
>

function registryOf(manager: SessionManager): SessionRegistry {
  return (manager as unknown as { sessions: SessionRegistry }).sessions
}

async function until(
  condition: () => boolean,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout: ${message}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Track the stub's one-shot READY marker on its (unclaimed) stdout. */
function sawReady(child: ChildProcess | null): boolean {
  const stream = child?.stdout
  if (!stream) return false
  const holder = stream as unknown as { __readySeen?: boolean }
  if (holder.__readySeen === undefined) {
    holder.__readySeen = false
    stream.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('READY')) {
        holder.__readySeen = true
      }
    })
  }
  return holder.__readySeen === true
}

describe('SessionManager', () => {
  test('removes the registry entry when the subprocess exits', async () => {
    const manager = new SessionManager(
      fakeBackend(bunScript('process.stdout.write("hi\\n"); process.exit(0)')),
    )
    const { id } = await manager.createSession({})
    expect(manager.sessionCount()).toBe(1)
    await until(
      () => manager.sessionCount() === 0,
      'exited session must deregister',
    )
    expect(manager.sessionCount()).toBe(0)
    expect(registryOf(manager).has(id)).toBe(false)
    manager.stop(false)
  })

  test('removes the entry on spawn failure (no leaked slot)', async () => {
    const manager = new SessionManager(
      fakeBackend({
        command: '/nonexistent-cc-session-binary',
        args: [],
        env: { ...process.env },
      }),
    )
    await manager.createSession({})
    await until(
      () => manager.sessionCount() === 0,
      'failed spawn must deregister',
    )
    manager.stop(false)
  })

  test('destroySession escalates SIGTERM to SIGKILL after the grace', async () => {
    // POSIX-robust SIGTERM-ignoring stub: `trap "" TERM` makes the shell and
    // its children inherit an ignored SIGTERM, so only the SIGKILL backstop
    // can reap it. The stub prints READY after the trap is installed; the
    // destroy fires only then — a SIGTERM racing the exec before the trap
    // exists would kill the stub with its default disposition instead.
    const manager = new SessionManager(
      fakeBackend({
        command: 'sh',
        args: ['-c', 'trap "" TERM; echo READY; sleep 30'],
        env: { ...process.env },
      }),
      { killGraceMs: 100 },
    )
    const { id } = await manager.createSession({})
    const child = registryOf(manager).get(id)?.info.process ?? null
    expect(child).not.toBeNull()

    await until(() => sawReady(child), 'stub must install its TERM trap').catch(
      err => {
        throw new Error(
          `${(err as Error).message} [child pid=${child?.pid} signalCode=${child?.signalCode} exitCode=${child?.exitCode} stdoutReadable=${child?.stdout?.readable} readySeen=${(child?.stdout as unknown as { __readySeen?: boolean } | null)?.__readySeen}]`,
        )
      },
    )

    const removed = await manager.destroySession(id)
    expect(removed).toBe(true)
    expect(manager.sessionCount()).toBe(0)

    // The stub ignores SIGTERM — only the SIGKILL backstop can reap it.
    await until(
      () => child?.signalCode === 'SIGKILL',
      'SIGTERM-ignoring child must be SIGKILLed',
    )
  })

  test('oversized lineless stdout cannot wedge the registry', async () => {
    const manager = new SessionManager(
      fakeBackend(
        bunScript(
          'process.stdout.write("x".repeat(3 * 1024 * 1024)); process.stdout.write("\\n"); process.exit(0)',
        ),
      ),
    )
    await manager.createSession({})
    await until(
      () => manager.sessionCount() === 0,
      'buffer-cap session must still deregister on exit',
    )
    manager.stop(false)
  })

  test('sweep reaps stopped residue past the TTL', async () => {
    const manager = new SessionManager(
      fakeBackend(bunScript('setInterval(() => {}, 1000)')),
      {
        killGraceMs: 50,
      },
    )
    const { id } = await manager.createSession({})
    const registry = registryOf(manager)
    const child = registry.get(id)?.info.process ?? null

    // Simulate a record left behind in 'stopped' past the TTL.
    const record = registry.get(id)
    if (!record) throw new Error('session record missing')
    record.info.status = 'stopped'
    record.stoppedAt = Date.now() - 10 * 60_000

    ;(
      manager as unknown as { sweepStoppedRecords: () => void }
    ).sweepStoppedRecords()
    expect(manager.sessionCount()).toBe(0)

    // The subprocess outlives the registry entry — reap it so the test
    // runner event loop can drain.
    const exited = new Promise<void>(resolve =>
      child?.once('exit', () => resolve()),
    )
    child?.kill('SIGKILL')
    await exited
    manager.stop(false)
  })
})
