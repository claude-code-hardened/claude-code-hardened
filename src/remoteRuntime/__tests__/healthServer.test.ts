import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  RUNNER_HEALTH_PORT_DEFAULT,
  type RunnerHealthzHandle,
  closeRunnerHealthz,
  maybeStartRunnerHealthz,
  resolveRunnerHealthPort,
  startRunnerHealthzListener,
} from '../healthServer.js'
import { createServer, type Server } from 'net'

/** Port holders to be released after all tests. */
const portHolders: Server[] = []
/** Singleton teardowns drained after each test. */
const singletonCloses: Array<Promise<void>> = []

afterEach(() => {
  singletonCloses.push(closeRunnerHealthz())
})

afterAll(async () => {
  await Promise.all(singletonCloses)
  for (const holder of portHolders.splice(0)) {
    await new Promise<void>(resolve => {
      holder.close(() => resolve())
    })
  }
})

/**
 * Bind a placeholder listener that HOLDS a port for the duration of a
 * test, so a second bind on the same port deterministically loses with
 * EADDRINUSE. The holder is released in afterAll.
 */
async function holdPort(): Promise<number> {
  const holder = createServer()
  await new Promise<void>(resolve => {
    holder.listen(0, '127.0.0.1', resolve)
  })
  portHolders.push(holder)
  return (holder.address() as { port: number }).port
}

/** Find a free port by binding-and-releasing an ephemeral listener. */
async function pickFreePort(): Promise<number> {
  const holder = createServer()
  await new Promise<void>(resolve => {
    holder.listen(0, '127.0.0.1', resolve)
  })
  const port = (holder.address() as { port: number }).port
  await new Promise<void>(resolve => {
    holder.close(() => resolve())
  })
  return port
}

describe('resolveRunnerHealthPort', () => {
  test('returns null when nothing is configured (default disabled)', () => {
    expect(resolveRunnerHealthPort(['claude', 'worker'], {})).toBeNull()
    expect(
      resolveRunnerHealthPort([], { SELF_HOSTED_RUNNER_HEALTH_PORT: '' }),
    ).toBeNull()
  })

  test('parses --health-port=N and --health-port N from argv, flag wins over env', () => {
    expect(
      resolveRunnerHealthPort(['run', '--health-port=9999'], {
        SELF_HOSTED_RUNNER_HEALTH_PORT: '1234',
      }),
    ).toBe(9999)
    expect(resolveRunnerHealthPort(['run', '--health-port', '7331'], {})).toBe(
      7331,
    )
  })

  test('bare --health-port falls back to the official 8080 default', () => {
    expect(resolveRunnerHealthPort(['run', '--health-port'], {})).toBe(
      RUNNER_HEALTH_PORT_DEFAULT,
    )
  })

  test('falls back to env when the flag is absent', () => {
    expect(
      resolveRunnerHealthPort([], { CLAUDE_CODE_RUNNER_HEALTH_PORT: '4545' }),
    ).toBe(4545)
    expect(
      resolveRunnerHealthPort([], { SELF_HOSTED_RUNNER_HEALTH_PORT: '8181' }),
    ).toBe(8181)
  })

  test('0 / false / off explicitly disable (official "0 means disabled")', () => {
    expect(resolveRunnerHealthPort(['run', '--health-port=0'], {})).toBeNull()
    expect(
      resolveRunnerHealthPort([], { SELF_HOSTED_RUNNER_HEALTH_PORT: '0' }),
    ).toBeNull()
    expect(
      resolveRunnerHealthPort([], { SELF_HOSTED_RUNNER_HEALTH_PORT: 'false' }),
    ).toBeNull()
    expect(
      resolveRunnerHealthPort([], { SELF_HOSTED_RUNNER_HEALTH_PORT: 'off' }),
    ).toBeNull()
  })

  test('unparsable values are rejected (never a random port)', () => {
    expect(
      resolveRunnerHealthPort([], { SELF_HOSTED_RUNNER_HEALTH_PORT: 'abc' }),
    ).toBeNull()
    expect(
      resolveRunnerHealthPort([], { SELF_HOSTED_RUNNER_HEALTH_PORT: '99999' }),
    ).toBeNull()
    expect(
      resolveRunnerHealthPort([], { SELF_HOSTED_RUNNER_HEALTH_PORT: '-3' }),
    ).toBeNull()
  })
})

describe('startRunnerHealthzListener (/healthz)', () => {
  test('serves 200 {"ok":true,"path":"/healthz"} on GET /healthz', async () => {
    const handle: RunnerHealthzHandle | null =
      await startRunnerHealthzListener(0)
    expect(handle).not.toBeNull()
    expect(handle!.port).toBeGreaterThan(0)

    const res = await fetch(`http://127.0.0.1:${handle!.port}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, path: '/healthz' })

    await handle!.close()
  })

  test('ANY path answers 200 with the state in the body (official: always 200)', async () => {
    const handle = await startRunnerHealthzListener(0)

    // Official semantics (runbook §9): "always returns 200 — read the body
    // for state". A wrong path is diagnosable via the body's path field.
    const miss = await fetch(`http://127.0.0.1:${handle!.port}/live`)
    expect(miss.status).toBe(200)
    expect(await miss.json()).toEqual({ ok: true, path: '/live' })

    const nested = await fetch(`http://127.0.0.1:${handle!.port}/deep/path?q=1`)
    expect(nested.status).toBe(200)
    expect(await nested.json()).toEqual({ ok: true, path: '/deep/path' })

    await handle!.close()
  })

  test('non-GET methods also answer 200 (status code never encodes health)', async () => {
    const handle = await startRunnerHealthzListener(0)
    for (const method of ['POST', 'HEAD', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${handle!.port}/healthz`, {
        method,
      })
      expect(res.status).toBe(200)
      if (method !== 'HEAD') {
        expect(await res.json()).toEqual({ ok: true, path: '/healthz' })
      }
    }
    await handle!.close()
  })

  test('EADDRINUSE degrades to a warn + null instead of crashing', async () => {
    const busyPort = await holdPort()
    const handle = await startRunnerHealthzListener(busyPort)
    expect(handle).toBeNull()
  })
})

describe('maybeStartRunnerHealthz (process singleton)', () => {
  test('disabled with no port configured — repeated calls stay null', async () => {
    expect(await maybeStartRunnerHealthz(['run'], {})).toBeNull()
    expect(await maybeStartRunnerHealthz(['run'], {})).toBeNull()
  })

  test('disabled with --health-port=0 (explicit off)', async () => {
    expect(
      await maybeStartRunnerHealthz(['run', '--health-port=0'], {}),
    ).toBeNull()
  })

  test('starts exactly one listener; later calls return the same handle', async () => {
    const argv = ['run', `--health-port=${await pickFreePort()}`]
    const first: RunnerHealthzHandle | null = await maybeStartRunnerHealthz(
      argv,
      {},
    )
    expect(first).not.toBeNull()
    const second = await maybeStartRunnerHealthz([], {})
    expect(second).toBe(first)

    const res = await fetch(`http://127.0.0.1:${first!.port}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, path: '/healthz' })
    await first!.close()
  })
})
