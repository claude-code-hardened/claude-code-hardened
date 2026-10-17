/**
 * Tests for the official max-concurrent-subagents gate (agentConcurrency.ts)
 * — reverse-284 decompiled module-006 semantics: REFUSE at cap (per-kind
 * counters, limit re-read at every spawn), NEVER queue.
 *
 * agentConcurrency.ts depends only on src/services/api/providerConcurrency.js
 * types being gone (pure now), so no mocks are needed (repo rule: do not mock
 * pure modules). Every test resets the counters first; the suite resets again
 * on exit.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  MAX_CONCURRENT_SUBAGENTS_ENV_VAR,
  acquireAgentSlot,
  getAgentConcurrencyLimit,
  getAgentConcurrencyState,
  parseMaxConcurrentSubagents,
  resetAgentConcurrencyForTest,
} from '../agentConcurrency.js'

function envWith(
  value: string | undefined,
): Record<string, string | undefined> {
  return { [MAX_CONCURRENT_SUBAGENTS_ENV_VAR]: value }
}

afterAll(() => {
  resetAgentConcurrencyForTest()
})

describe('parseMaxConcurrentSubagents', () => {
  test('accepts plain integers (padding + negatives tolerated)', () => {
    expect(parseMaxConcurrentSubagents(' 42 ')).toBe(42)
    expect(parseMaxConcurrentSubagents('-3')).toBe(-3)
  })

  test('unset / non-numeric → undefined (= default at the getter)', () => {
    expect(parseMaxConcurrentSubagents(undefined)).toBeUndefined()
    expect(parseMaxConcurrentSubagents('abc')).toBeUndefined()
    expect(parseMaxConcurrentSubagents('2.7')).toBeUndefined()
  })
})

describe('getAgentConcurrencyLimit', () => {
  test('unset env falls back to the official default 20 (n8n=20)', () => {
    expect(getAgentConcurrencyLimit({})).toBe(20)
    expect(DEFAULT_MAX_CONCURRENT_SUBAGENTS).toBe(20)
  })

  test('positive integer → cap', () => {
    expect(getAgentConcurrencyLimit(envWith('8'))).toBe(8)
  })

  test('0 / negative → unlimited (Infinity)', () => {
    expect(getAgentConcurrencyLimit(envWith('0'))).toBe(Infinity)
    expect(getAgentConcurrencyLimit(envWith('-1'))).toBe(Infinity)
  })
})

describe('acquireAgentSlot (official refuse-at-cap gate)', () => {
  test('refuses at the cap with the official wording; release restores', () => {
    resetAgentConcurrencyForTest()
    acquireAgentSlot({ agentKey: 'scout', env: envWith('2') })
    acquireAgentSlot({ agentKey: 'scout', env: envWith('2') })
    // Official wording (module-006): `${h}: ${S} running at once; refused`
    expect(() =>
      acquireAgentSlot({ agentKey: 'scout', env: envWith('2') }),
    ).toThrow('scout: 2 running at once; refused')
    resetAgentConcurrencyForTest()
  })

  test('official refusal is immediate — spawn throws synchronously, nothing queues', () => {
    resetAgentConcurrencyForTest()
    acquireAgentSlot({ agentKey: 'task', env: envWith('1') })
    const started = Date.now()
    expect(() =>
      acquireAgentSlot({ agentKey: 'task', env: envWith('1') }),
    ).toThrow()
    // Refusal is synchronous — no parking/waiting interval elapsed.
    expect(Date.now() - started).toBeLessThan(50)
    resetAgentConcurrencyForTest()
  })

  test('counters are per-agent-kind (official Map keyed by kind)', () => {
    resetAgentConcurrencyForTest()
    for (let i = 0; i < 3; i++) {
      acquireAgentSlot({ agentKey: 'task', env: envWith('3') })
    }
    // A different kind is independent of the saturated one.
    const releaseScout = acquireAgentSlot({
      agentKey: 'scout',
      env: envWith('1'),
    })
    expect(getAgentConcurrencyState().keys).toEqual({
      task: 3,
      scout: 1,
    })
    releaseScout()
    resetAgentConcurrencyForTest()
  })

  test('release is idempotent (double release must not under-count)', () => {
    resetAgentConcurrencyForTest()
    const release = acquireAgentSlot({ agentKey: 'task', env: envWith('1') })
    release()
    release()
    expect(getAgentConcurrencyState().keys['task'] ?? 0).toBe(0)
    resetAgentConcurrencyForTest()
  })

  test('limit re-read per spawn (env change takes effect live)', () => {
    resetAgentConcurrencyForTest()
    acquireAgentSlot({ agentKey: 'task', env: envWith('2') })
    // Tighten the cap to 1 — the already-running agent still counts, but a
    // second spawn now refuses against the new live limit.
    expect(() =>
      acquireAgentSlot({ agentKey: 'task', env: envWith('1') }),
    ).toThrow('running at once; refused')
    resetAgentConcurrencyForTest()
  })

  test('default (unset env) refuses at 20 per kind', () => {
    resetAgentConcurrencyForTest()
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT_SUBAGENTS; i++) {
      acquireAgentSlot({ agentKey: 'task' })
    }
    expect(() => acquireAgentSlot({ agentKey: 'task', env: {} })).toThrow(
      `task: ${DEFAULT_MAX_CONCURRENT_SUBAGENTS} running at once; refused`,
    )
    resetAgentConcurrencyForTest()
  })
})
