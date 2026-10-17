/**
 * Tests for the OpenAI streaming idle watchdog + in-flight registry.
 *
 * The watchdog is layered over the SDK's async iterable: silence longer than
 * CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS aborts the request through the watchdog
 * signal and lands a StreamIdleTimeoutError, so a stalled relay can no longer
 * leave the consuming generator frame (and its full request body) rooted
 * forever.
 *
 * Mock contract: "stalled SDK stream" = an async iterable whose next() never
 * settles (exactly what a broken relay produces at the iterator surface).
 */
import { describe, expect, test, afterEach, mock } from 'bun:test'
import { debugMock } from '../../../../../tests/mocks/debug'

mock.module('../../../../utils/debug.js', () => debugMock())

type StreamWatchdogModule = typeof import('../streamWatchdog.js')

async function loadModule(): Promise<StreamWatchdogModule> {
  return await import('../streamWatchdog.js')
}

const IDLE_ENV = 'CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS'

function setIdleEnv(value: string): string | undefined {
  const previous = process.env[IDLE_ENV]
  process.env[IDLE_ENV] = value
  return previous
}

function restoreIdleEnv(previous: string | undefined): void {
  if (previous === undefined) delete process.env[IDLE_ENV]
  else process.env[IDLE_ENV] = previous
}

/** Async iterable whose next() never settles — a stalled relay. */
function makeNeverSettlingStream(): AsyncIterable<never> {
  const iterator = {
    next: () => new Promise<IteratorResult<never>>(() => {}),
    return: () =>
      Promise.resolve<IteratorResult<never>>({
        done: true,
        value: undefined as never,
      }),
  }
  return {
    [Symbol.asyncIterator]: () => iterator as AsyncIterator<never>,
  }
}

/** Async iterable emitting `count` chunks with a small delay between them. */
async function* makeFastStream(
  count: number,
  delayMs: number,
): AsyncGenerator<number, void, undefined> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, delayMs))
    yield i
  }
}

/** Drain a wrapped stream, capturing chunks and any thrown error. */
async function drainStream<T>(
  stream: AsyncIterable<T>,
): Promise<{ chunks: T[]; error: unknown; settled: boolean }> {
  const chunks: T[] = []
  let error: unknown = null
  let settled = false
  try {
    for await (const chunk of stream) chunks.push(chunk)
    settled = true
  } catch (caught) {
    error = caught
  }
  return { chunks, error, settled }
}

afterEach(() => {
  delete process.env[IDLE_ENV]
})

describe('getStreamIdleTimeoutMs (env face)', () => {
  test('defaults to 300000ms when the env var is unset', async () => {
    const { getStreamIdleTimeoutMs } = await loadModule()
    delete process.env[IDLE_ENV]
    expect(getStreamIdleTimeoutMs()).toBe(300_000)
  })

  test('reads a custom value from the env var', async () => {
    const { getStreamIdleTimeoutMs } = await loadModule()
    process.env[IDLE_ENV] = '5000'
    expect(getStreamIdleTimeoutMs()).toBe(5000)
  })

  test('0 disables the watchdog', async () => {
    const { getStreamIdleTimeoutMs } = await loadModule()
    process.env[IDLE_ENV] = '0'
    expect(getStreamIdleTimeoutMs()).toBe(0)
  })

  test('invalid or negative values fall back to the default', async () => {
    const { getStreamIdleTimeoutMs } = await loadModule()
    process.env[IDLE_ENV] = 'abc'
    expect(getStreamIdleTimeoutMs()).toBe(300_000)
    process.env[IDLE_ENV] = '-1'
    expect(getStreamIdleTimeoutMs()).toBe(300_000)
  })
})

describe('in-flight registry', () => {
  test('registers url/model/startedAt at creation and clears on settle', async () => {
    const { createStreamWatchdog, getInFlightApiRequests } = await loadModule()
    const watchdog = createStreamWatchdog({
      url: 'http://127.0.0.1:17892/v1/chat/completions',
      model: 'relay-model',
    })

    const entry = getInFlightApiRequests().find(
      e => e.requestId === watchdog.requestId,
    )
    expect(entry).toBeDefined()
    expect(entry?.url).toBe('http://127.0.0.1:17892/v1/chat/completions')
    expect(entry?.model).toBe('relay-model')
    expect(entry?.startedAt).toBeGreaterThan(0)

    watchdog.settle()
    expect(
      getInFlightApiRequests().find(e => e.requestId === watchdog.requestId),
    ).toBeUndefined()

    // settle() is idempotent — double-settle must not throw.
    watchdog.settle()
  })
})

describe('stream idle watchdog', () => {
  test('aborts a stalled stream, lands a structured error, clears the registry', async () => {
    const {
      createStreamWatchdog,
      getInFlightApiRequests,
      StreamIdleTimeoutError,
    } = await loadModule()
    const previous = setIdleEnv('50')
    try {
      const watchdog = createStreamWatchdog({
        url: 'http://127.0.0.1:17892/v1/chat/completions',
        model: 'relay-model',
      })

      const wrapped = watchdog.wrap(makeNeverSettlingStream())
      const outcome = await drainStream(wrapped)

      expect(outcome.chunks).toHaveLength(0)
      expect(outcome.settled).toBe(false)
      expect(outcome.error).toBeInstanceOf(StreamIdleTimeoutError)
      const message = (outcome.error as Error).message
      expect(message).toContain('idle timeout')
      expect(message).toContain('relay-model')
      expect(message).toContain(watchdog.requestId)

      // The watchdog aborted through its own signal (the one handed to
      // create()), which is what tears down the stuck body read.
      expect(watchdog.signal.aborted).toBe(true)

      // Registry entry is settled via the wrapped stream's finally.
      expect(
        getInFlightApiRequests().find(e => e.requestId === watchdog.requestId),
      ).toBeUndefined()
    } finally {
      restoreIdleEnv(previous)
    }
  })

  test('healthy chunks below the silence window are fully consumed', async () => {
    const { createStreamWatchdog, getInFlightApiRequests } = await loadModule()
    // 250ms silence budget vs 10ms chunk cadence — must never trip.
    const previous = setIdleEnv('250')
    try {
      const watchdog = createStreamWatchdog({
        url: 'http://127.0.0.1:17892/v1/chat/completions',
        model: 'relay-model',
      })

      const outcome = await drainStream(watchdog.wrap(makeFastStream(4, 10)))

      expect(outcome.error).toBeNull()
      expect(outcome.settled).toBe(true)
      expect(outcome.chunks).toEqual([0, 1, 2, 3])
      expect(watchdog.signal.aborted).toBe(false)
      expect(
        getInFlightApiRequests().find(e => e.requestId === watchdog.requestId),
      ).toBeUndefined()
    } finally {
      restoreIdleEnv(previous)
    }
  })

  test('timeout=0 disables the watchdog (stalled stream survives grace window)', async () => {
    const { createStreamWatchdog, getInFlightApiRequests } = await loadModule()
    const previous = setIdleEnv('0')
    try {
      const watchdog = createStreamWatchdog({
        url: 'http://127.0.0.1:17892/v1/chat/completions',
        model: 'relay-model',
      })

      const outcomePromise = drainStream(
        watchdog.wrap(makeNeverSettlingStream()),
      )
      const stillPending = await Promise.race([
        outcomePromise,
        new Promise<'still-pending'>(resolve =>
          setTimeout(() => resolve('still-pending'), 120),
        ),
      ])

      // No watchdog abort while disabled — consumption stays pending, signal
      // stays clean.
      expect(stillPending).toBe('still-pending')
      expect(watchdog.signal.aborted).toBe(false)

      // Dangling drain cannot settle via its finally (never-settling mock);
      // the caller contract covers teardown.
      watchdog.settle()
      expect(
        getInFlightApiRequests().find(e => e.requestId === watchdog.requestId),
      ).toBeUndefined()
    } finally {
      restoreIdleEnv(previous)
    }
  })

  test('external abort unblocks a never-settling stream and settles the registry', async () => {
    const { createStreamWatchdog, getInFlightApiRequests } = await loadModule()
    const previous = setIdleEnv('300000')
    try {
      const external = new AbortController()
      const watchdog = createStreamWatchdog({
        url: 'http://127.0.0.1:17892/v1/chat/completions',
        model: 'relay-model',
        externalSignal: external.signal,
      })
      setTimeout(() => external.abort(new Error('user cancelled')), 40)

      const outcome = await drainStream(
        watchdog.wrap(makeNeverSettlingStream()),
      )

      expect(outcome.settled).toBe(false)
      expect((outcome.error as Error).message).toBe('user cancelled')
      expect(watchdog.signal.aborted).toBe(true)
      expect(
        getInFlightApiRequests().find(e => e.requestId === watchdog.requestId),
      ).toBeUndefined()
    } finally {
      restoreIdleEnv(previous)
    }
  })
})

describe('first-byte establishment guard', () => {
  test('aborts an establishment that never returns headers, before wrap()', async () => {
    const { createStreamWatchdog, getInFlightApiRequests } = await loadModule()
    const previous = setIdleEnv('300000')
    try {
      // Simulates a relay that accepts the request and never answers:
      // nothing is wrapped yet — the guard must fire from creation alone.
      const watchdog = createStreamWatchdog({
        url: 'http://127.0.0.1:17892/v1/chat/completions',
        model: 'relay-model',
        firstByteTimeoutMs: 25,
      })
      const aborted = await new Promise<unknown>(resolve => {
        if (watchdog.signal.aborted) resolve(watchdog.signal.reason)
        watchdog.signal.addEventListener('abort', () =>
          resolve(watchdog.signal.reason),
        )
      })

      expect(watchdog.signal.aborted).toBe(true)
      const { StreamIdleTimeoutError: IdleError } = await loadModule()
      expect(aborted).toBeInstanceOf(IdleError)
      // Registry entry still cleared (settle path exists for the caller's
      // catch in the adapters).
      watchdog.settle()
      expect(
        getInFlightApiRequests().find(e => e.requestId === watchdog.requestId),
      ).toBeUndefined()
    } finally {
      restoreIdleEnv(previous)
    }
  })

  test('a healthy stream established after the guard window still consumes fully', async () => {
    const { createStreamWatchdog } = await loadModule()
    const previous = setIdleEnv('300000')
    try {
      const watchdog = createStreamWatchdog({
        url: 'http://127.0.0.1:17892/v1/chat/completions',
        model: 'relay-model',
        firstByteTimeoutMs: 30,
      })
      // Establishment returns within the guard window, but the first chunk
      // is slow (past what remained of the first-byte window). wrap() hands
      // consumption over to the idle window, so a slow first chunk is not
      // false-tripped by the already-elapsed creation window.
      const wrapped = watchdog.wrap(makeFastStream(2, 60))
      const outcome = await drainStream(wrapped)
      expect(outcome.chunks).toEqual([0, 1])
      expect(outcome.error).toBeNull()
      expect(outcome.settled).toBe(true)
      expect(watchdog.signal.aborted).toBe(false)
      watchdog.settle()
    } finally {
      restoreIdleEnv(previous)
    }
  })
})

describe('first-byte guard suppression (watchdog fully disabled)', () => {
  test('idle=0 suppresses the creation-time first-byte arm entirely', async () => {
    const { createStreamWatchdog } = await loadModule()
    const previous = setIdleEnv('0')
    try {
      const watchdog = createStreamWatchdog({
        url: 'http://127.0.0.1:17892/v1/chat/completions',
        model: 'relay-model',
        // firstByteTimeoutMs deliberately left to env default (120s) —
        // idle=0 must suppress it regardless ("0 = fully off" contract).
      })
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(watchdog.signal.aborted).toBe(false)
      watchdog.settle()
    } finally {
      restoreIdleEnv(previous)
    }
  })

  test('markEstablished disarms a nearly-spent first-byte window', async () => {
    const { createStreamWatchdog } = await loadModule()
    const previous = setIdleEnv('300000')
    try {
      const watchdog = createStreamWatchdog({
        url: 'http://127.0.0.1:17892/v1/chat/completions',
        model: 'relay-model',
        firstByteTimeoutMs: 20,
      })
      // Establishment resolves at 15ms; markEstablished simulates the
      // adapter handing the stream over — the 20ms guard must not fire.
      await new Promise(resolve => setTimeout(resolve, 15))
      watchdog.markEstablished()
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(watchdog.signal.aborted).toBe(false)
      watchdog.settle()
    } finally {
      restoreIdleEnv(previous)
    }
  })
})
