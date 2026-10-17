/**
 * providerConcurrency unit tests — layer-2 per-provider stream cap.
 *
 * providerConcurrency.ts is dependency-free, so no mocks are needed (repo
 * rule: do not mock pure modules). Reference semantics:
 * /root/oh-my-pi/packages/coding-agent/src/task/provider-concurrency.ts
 * (slot brackets only the streaming HTTP request; OMP issues #3749 / #3464).
 */
import { describe, expect, test } from 'bun:test'
import {
  FifoSemaphore,
  PROVIDER_MAX_CONCURRENCY_ENV_VAR,
  getProviderConcurrencyLimit,
  getProviderConcurrencyState,
  getProviderSemaphore,
  parseProviderMaxConcurrency,
  releaseOnStreamEnd,
  resetProviderConcurrencyForTest,
  withProviderSlot,
} from '../providerConcurrency.js'

const TICK = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function envWith(value: string): Record<string, string | undefined> {
  return { [PROVIDER_MAX_CONCURRENCY_ENV_VAR]: value }
}

const CAP1 = envWith('1')

function counterStream(count: number): AsyncGenerator<number, void> {
  return (async function* () {
    for (let i = 0; i < count; i++) {
      yield i
    }
  })()
}

describe('parseProviderMaxConcurrency', () => {
  test('parses plain integers (padding + negatives tolerated)', () => {
    expect(parseProviderMaxConcurrency('8')).toBe(8)
    expect(parseProviderMaxConcurrency(' 4 ')).toBe(4)
    expect(parseProviderMaxConcurrency('0')).toBe(0)
    expect(parseProviderMaxConcurrency('-2')).toBe(-2)
  })

  test('unset / non-numeric → undefined (= Unlimited at the getter)', () => {
    expect(parseProviderMaxConcurrency(undefined)).toBeUndefined()
    expect(parseProviderMaxConcurrency('')).toBeUndefined()
    expect(parseProviderMaxConcurrency('abc')).toBeUndefined()
    expect(parseProviderMaxConcurrency('2.5')).toBeUndefined()
    expect(parseProviderMaxConcurrency('  ')).toBeUndefined()
  })
})

describe('getProviderConcurrencyLimit', () => {
  test('unset env → Unlimited (Infinity)', () => {
    expect(getProviderConcurrencyLimit({})).toBe(Number.POSITIVE_INFINITY)
    expect(
      getProviderConcurrencyLimit({
        [PROVIDER_MAX_CONCURRENCY_ENV_VAR]: undefined,
      }),
    ).toBe(Number.POSITIVE_INFINITY)
  })

  test('positive integer → finite cap', () => {
    expect(getProviderConcurrencyLimit(envWith('3'))).toBe(3)
  })

  test('0 / negative / invalid → Unlimited (≤0 = Infinity, still counted)', () => {
    expect(getProviderConcurrencyLimit(envWith('0'))).toBe(
      Number.POSITIVE_INFINITY,
    )
    expect(getProviderConcurrencyLimit(envWith('-1'))).toBe(
      Number.POSITIVE_INFINITY,
    )
    expect(getProviderConcurrencyLimit(envWith('quiet'))).toBe(
      Number.POSITIVE_INFINITY,
    )
  })
})

describe('FifoSemaphore', () => {
  test('grants up to the limit immediately and queues the rest', async () => {
    const semaphore = new FifoSemaphore(2)
    await semaphore.acquire()
    await semaphore.acquire()
    expect(semaphore.active).toBe(2)

    const third = semaphore.acquire()
    const fourth = semaphore.acquire()
    expect(semaphore.waiting).toBe(2)
    expect(semaphore.active).toBe(2)

    semaphore.release()
    await third
    expect(semaphore.active).toBe(2)
    expect(semaphore.waiting).toBe(1)

    semaphore.release()
    await fourth
    expect(semaphore.waiting).toBe(0)
  })

  test('wakes waiters in FIFO order', async () => {
    const semaphore = new FifoSemaphore(1)
    const granted: number[] = []
    await semaphore.acquire()
    const waiters = [0, 1, 2, 3, 4].map(i =>
      semaphore.acquire().then(() => {
        granted.push(i)
      }),
    )
    expect(semaphore.waiting).toBe(5)
    for (const waiter of waiters) {
      semaphore.release()
      await waiter
    }
    expect(granted).toEqual([0, 1, 2, 3, 4])
  })

  test('resize in place (#3464): raising wakes queued waiters, lowering never revokes in-flight', async () => {
    const semaphore = new FifoSemaphore(1)
    await semaphore.acquire()
    const second = semaphore.acquire()
    const third = semaphore.acquire()
    expect(semaphore.waiting).toBe(2)

    // Raising the limit wakes as many waiters as the new capacity allows,
    // on the SAME instance (in-flight slots are not orphaned).
    semaphore.resize(3)
    await second
    await third
    expect(semaphore.waiting).toBe(0)
    expect(semaphore.active).toBe(3)

    // Lowering below active: nothing is revoked, new acquires queue.
    semaphore.resize(1)
    const fourth = semaphore.acquire()
    expect(semaphore.waiting).toBe(1)
    semaphore.release()
    semaphore.release()
    semaphore.release()
    await fourth
    expect(semaphore.active).toBe(1)
    expect(semaphore.waiting).toBe(0)
  })

  test('unlimited (Infinity) still counts active slots', async () => {
    const semaphore = new FifoSemaphore(Infinity)
    expect(semaphore.limit).toBe(Number.POSITIVE_INFINITY)
    await semaphore.acquire()
    await semaphore.acquire()
    await semaphore.acquire()
    expect(semaphore.active).toBe(3)

    // Resize to 2: in-flight 3 stays, the next acquire queues.
    semaphore.resize(2)
    const fourth = semaphore.acquire()
    expect(semaphore.waiting).toBe(1)
    semaphore.release()
    semaphore.release()
    await fourth
    expect(semaphore.active).toBe(2)
    expect(semaphore.waiting).toBe(0)
  })

  test('abort while queued removes the waiter without consuming a slot', async () => {
    const semaphore = new FifoSemaphore(1)
    const controller = new AbortController()
    await semaphore.acquire()
    const queued = semaphore.acquire(controller.signal)
    expect(semaphore.waiting).toBe(1)
    controller.abort()
    await expect(queued).rejects.toThrow('aborted while queued')
    expect(semaphore.waiting).toBe(0)
    expect(semaphore.active).toBe(1)
    semaphore.release()
    expect(semaphore.active).toBe(0)
  })
})

describe('withProviderSlot', () => {
  test('release-after-stream: held from acquire through full consumption', async () => {
    resetProviderConcurrencyForTest()
    const provider = 'test-openai-full'

    let established = 0
    const stream = await withProviderSlot(
      provider,
      async release => {
        established += 1
        expect(getProviderConcurrencyState(provider)?.active).toBe(1)
        return releaseOnStreamEnd(counterStream(3), release)
      },
      undefined,
      CAP1,
    )
    expect(established).toBe(1)
    // Still held BEFORE consumption finishes (slot spans the in-flight
    // stream, not just its establishment).
    expect(getProviderConcurrencyState(provider)?.active).toBe(1)

    let seen = 0
    for await (const _chunk of stream) {
      seen += 1
      expect(getProviderConcurrencyState(provider)?.active).toBe(1)
    }
    expect(seen).toBe(3)
    expect(getProviderConcurrencyState(provider)?.active).toBe(0)
    expect(getProviderConcurrencyState(provider)?.limit).toBe(1)
  })

  test('consumer break releases the slot (generator .return() path)', async () => {
    resetProviderConcurrencyForTest()
    const provider = 'test-openai-break'

    const stream = await withProviderSlot(
      provider,
      async release => releaseOnStreamEnd(counterStream(10), release),
      undefined,
      CAP1,
    )
    for await (const _chunk of stream) {
      break
    }
    const state = getProviderConcurrencyState(provider)
    expect(state?.active).toBe(0)
    expect(state?.waiting).toBe(0)
  })

  test('establish failure releases the slot instead of leaking it', async () => {
    resetProviderConcurrencyForTest()
    const provider = 'test-openai-fail'

    await expect(
      withProviderSlot(
        provider,
        async () => {
          throw new Error('establishment exhausted')
        },
        undefined,
        CAP1,
      ),
    ).rejects.toThrow('establishment exhausted')
    expect(getProviderConcurrencyState(provider)?.active).toBe(0)
  })

  test('second request queues until the first stream settles', async () => {
    resetProviderConcurrencyForTest()
    const provider = 'test-openai-queue'

    const first = await withProviderSlot(
      provider,
      async release => releaseOnStreamEnd(counterStream(100), release),
      undefined,
      CAP1,
    )
    let secondEstablished = false
    const second = withProviderSlot(
      provider,
      async release => {
        secondEstablished = true
        return releaseOnStreamEnd(counterStream(1), release)
      },
      undefined,
      CAP1,
    )
    await TICK()
    expect(secondEstablished).toBe(false)
    expect(getProviderConcurrencyState(provider)?.waiting).toBe(1)

    for await (const _chunk of first) {
      break
    }
    const secondStream = await second
    expect(secondEstablished).toBe(true)
    // The second slot is only released when ITS stream is consumed too.
    let secondSeen = 0
    for await (const _chunk of secondStream) {
      secondSeen += 1
    }
    expect(secondSeen).toBe(1)
    expect(getProviderConcurrencyState(provider)?.active).toBe(0)
  })

  test('per-provider keys are isolated', async () => {
    resetProviderConcurrencyForTest()
    const openai = getProviderSemaphore('openai', CAP1)
    const gemini = getProviderSemaphore('gemini', CAP1)
    const grok = getProviderSemaphore('grok', CAP1)
    expect(openai).not.toBe(gemini)
    expect(gemini).not.toBe(grok)

    await openai.acquire()
    await gemini.acquire()
    expect(getProviderConcurrencyState('openai')?.active).toBe(1)
    expect(getProviderConcurrencyState('gemini')?.active).toBe(1)
    expect(getProviderConcurrencyState('grok')?.active).toBe(0)
  })

  test('limit change between acquires resizes the SAME semaphore in place', () => {
    resetProviderConcurrencyForTest()
    const first = getProviderSemaphore('openai', envWith('2'))
    expect(first.limit).toBe(2)

    const second = getProviderSemaphore('openai', envWith('5'))
    expect(second).toBe(first)
    expect(second.limit).toBe(5)

    const third = getProviderSemaphore('openai', {})
    expect(third).toBe(first)
    expect(third.limit).toBe(Number.POSITIVE_INFINITY)
  })
})
