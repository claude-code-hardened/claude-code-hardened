/**
 * Per-provider streaming-request concurrency cap — CCH port of the
 * oh-my-pi provider-concurrency semantics
 * (/root/oh-my-pi/packages/coding-agent/src/task/provider-concurrency.ts).
 *
 * WHY THE SLOT MUST NOT COVER THE WHOLE SUBAGENT (deadlock analysis, OMP
 * issue #3749): a semaphore hung on the *agent/tool-call lifetime* deadlocks
 * any spawn tree whose width exceeds the limit — a parent holds its slot
 * while awaiting its children's results, but the children cannot start
 * because every slot is held by the parents who are waiting for them
 * (issue #3749). Wiring the release to the whole subagent lifetime is
 * exactly that failure mode.
 *
 * Instead the semaphore brackets ONLY the streaming HTTP request: acquired
 * just before the provider establishment call (withConnectionRetry included
 * — establishment retries are part of the on-the-wire request) and released
 * the moment the adapted stream settles (normal end, error, consumer break
 * or teardown). A parent therefore holds at most one slot per in-flight
 * turn and frees it between turns, so children can always make progress as
 * long as fewer than `limit` streams are literally in flight.
 *
 * Release-point note: watchdog.settle() (openai/gemini streamWatchdog.ts)
 * fires from the wrapped stream's `finally` — that finally always runs
 * (完成/异常/中止三路必走) — but it is unreachable from outside the watchdog
 * closure. The release is therefore wired at the consumption boundary: the
 * adapted stream handed to the query loop is wrapped by releaseOnStreamEnd,
 * whose own finally fires when the consumer finishes; closing it closes the
 * adaptation chain, which closes the watchdog-wrapped stream and triggers
 * settle — the same teardown instant, one hop later.
 *
 * Layer-1 (max concurrent subagents, agentConcurrency.ts) and this cap are
 * independent switches.
 *
 * This module is intentionally PURE (no logger/analytics imports) so its
 * queueing/resize logic is unit-testable without mocks.
 */

/**
 * Env var: GLOBAL per-provider in-flight-stream cap (one knob for all
 * providers — deliberately simplified vs OMP's per-provider settings map).
 * A plain integer > 0 enables the cap; unset/invalid/<=0 = Unlimited.
 */
export const PROVIDER_MAX_CONCURRENCY_ENV_VAR =
  'CLAUDE_CODE_PROVIDER_MAX_CONCURRENCY'

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : Infinity
}

/**
 * FIFO semaphore with in-place resize. Release transfers the permit directly
 * to the head waiter (FIFO order preserved); new arrivals queue behind
 * existing waiters even when free capacity remains, so a resize-down then
 * resize-up cannot starve earlier waiters.
 *
 * Unlimited is `Infinity`: every acquire is granted immediately but still
 * accounted in `active`, so a runtime reconfiguration to a finite limit
 * starts counting work that began while unlimited (OMP semantics:
 * "≤0 = Infinity 仍计数").
 */
export class FifoSemaphore {
  private currentLimit: number
  private inFlight = 0
  private queued: Array<{ wake: () => void }> = []

  constructor(limit: number) {
    this.currentLimit = normalizeLimit(limit)
  }

  get limit(): number {
    return this.currentLimit
  }

  /** Slots currently held (in-flight streams / running subagents). */
  get active(): number {
    return this.inFlight
  }

  /** Waiters queued for a slot. */
  get waiting(): number {
    return this.queued.length
  }

  /**
   * Acquire a slot; resolves once the caller may proceed past the bracket.
   * `signal` aborts an in-progress wait (entry removed from the queue, no
   * slot consumed); a signal that is already aborted rejects immediately.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error(
        'Concurrency slot acquisition aborted (signal already aborted)',
      )
    }
    if (this.inFlight < this.currentLimit && this.queued.length === 0) {
      this.inFlight += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const removeEntry = () => {
        const idx = this.queued.indexOf(entry)
        if (idx >= 0) this.queued.splice(idx, 1)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        removeEntry()
        reject(new Error('Concurrency slot acquisition aborted while queued'))
      }
      const entry = {
        wake: () => {
          // Grant: the permit is accounted fresh — the woken waiter counts
          // as active from here (direct transfer, FIFO head first).
          removeEntry()
          this.inFlight += 1
          resolve()
        },
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.queued.push(entry)
    })
  }

  /** Release a held slot, waking the head waiter when capacity allows. */
  release(): void {
    if (this.inFlight === 0) return
    this.inFlight -= 1
    this.grantHeadIfCapacity()
  }

  /**
   * Change the ceiling without dropping accounting (OMP #3464 review
   * feedback: replacing the instance would orphan in-flight slots on the old
   * one and let mixed-limit traffic exceed the cap). Raising the limit wakes
   * as many queued waiters as the new capacity allows; lowering it only
   * throttles future grants — in-flight slots are never revoked.
   */
  resize(nextLimit: number): void {
    this.currentLimit = normalizeLimit(nextLimit)
    this.grantHeadIfCapacity()
  }

  private grantHeadIfCapacity(): void {
    while (this.inFlight < this.currentLimit && this.queued.length > 0) {
      const head = this.queued.shift()
      if (!head) break
      head.wake()
    }
  }
}

/**
 * Parse CLAUDE_CODE_PROVIDER_MAX_CONCURRENCY: plain (possibly negative)
 * integer → that value; unset or anything else → undefined (= Unlimited at
 * the getter).
 */
export function parseProviderMaxConcurrency(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^-?\d+$/.test(trimmed)) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isInteger(parsed) ? parsed : undefined
}

/** Resolve the configured ceiling: integer > 0 → finite cap, else Infinity. */
export function getProviderConcurrencyLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = parseProviderMaxConcurrency(
    env[PROVIDER_MAX_CONCURRENCY_ENV_VAR],
  )
  if (parsed === undefined || parsed <= 0) return Infinity
  return parsed
}

// ── per-provider registry ──────────────────────────────────────────────────
// One limiter per provider key ('openai' | 'gemini' | 'grok'), created
// lazily and resized in place when the env-configured limit changes between
// acquires (issue #3464).

const providerSemaphores = new Map<
  string,
  { limit: number; semaphore: FifoSemaphore }
>()

export function getProviderSemaphore(
  provider: string,
  env: Record<string, string | undefined> = process.env,
): FifoSemaphore {
  const limit = getProviderConcurrencyLimit(env)
  const existing = providerSemaphores.get(provider)
  if (existing) {
    if (existing.limit !== limit) {
      existing.limit = limit
      existing.semaphore.resize(limit)
    }
    return existing.semaphore
  }
  const semaphore = new FifoSemaphore(limit)
  providerSemaphores.set(provider, { limit, semaphore })
  return semaphore
}

/**
 * Bracket a streaming provider request with the provider's concurrency slot.
 *
 * Semantics: the slot is acquired BEFORE `establish` runs (so establishment
 * retries under withConnectionRetry count toward the cap) and, once
 * `establish` has resolved, RELEASE OWNERSHIP TRANSFERS to the `release`
 * callback it receives — the callback must be wired to the established
 * stream's end (via releaseOnStreamEnd on the adapted generator). If
 * `establish` throws (establishment retries spent, abort, ...), the slot is
 * released here and the error propagates unchanged. Release is idempotent.
 */
export async function withProviderSlot<T>(
  provider: string,
  establish: (release: () => void) => Promise<T>,
  signal?: AbortSignal,
  env: Record<string, string | undefined> = process.env,
): Promise<T> {
  const semaphore = getProviderSemaphore(provider, env)
  await semaphore.acquire(signal)
  let released = false
  const release = () => {
    if (released) return
    released = true
    semaphore.release()
  }
  try {
    return await establish(release)
  } catch (error) {
    // establish failed — no stream was handed out, so nothing else will
    // ever fire the release callback.
    release()
    throw error
  }
}

/**
 * Wrap an adapted stream so `release` fires exactly once when the stream
 * settles: normal completion, consumer error, consumer break (generator
 * .return()), or teardown. CCH equivalent of OMP's
 * `stream.result().then(release, release)`; closing this generator closes
 * the adaptation chain and the watchdog-wrapped stream it fronts (whose
 * finally runs watchdog.settle()).
 */
export async function* releaseOnStreamEnd<T>(
  stream: AsyncIterable<T>,
  release: () => void,
): AsyncGenerator<T, void, undefined> {
  try {
    for await (const chunk of stream) {
      yield chunk
    }
  } finally {
    release()
  }
}

/** Snapshot of a provider's limiter state (diagnostics / tests). */
export function getProviderConcurrencyState(
  provider: string,
): { limit: number; active: number; waiting: number } | undefined {
  const semaphore = providerSemaphores.get(provider)?.semaphore
  if (!semaphore) return undefined
  return {
    limit: semaphore.limit,
    active: semaphore.active,
    waiting: semaphore.waiting,
  }
}

/** Test-only: drop every limiter without waiting for in-flight streams. */
export function resetProviderConcurrencyForTest(): void {
  providerSemaphores.clear()
}
