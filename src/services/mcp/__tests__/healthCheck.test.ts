/**
 * Tests for the MCP connection liveness probe (mcp-dispatch health anchor):
 * one-shot ping with a hard timeout budget (structured result, never
 * throws), consecutive-failure counting, unhealthy/recover transition
 * callbacks, and lifecycle (idempotent start/stop + stop-all teardown).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

import { logMock } from '../../../../tests/mocks/log.js'
mock.module('src/utils/log.ts', logMock)

import {
  getServerHealth,
  isMcpHealthCheckEnabled,
  MCP_HEALTH_CHECK_ENV,
  probeServerHealth,
  startHealthCheck,
  stopAllHealthChecks,
  stopHealthCheck,
} from '../healthCheck.js'
import type { MCPServerHealth } from '../types.js'

function makeClient(ping: () => Promise<void>): Client {
  return { ping } as unknown as Client
}

function flush(ms: number): Promise<void> {
  return Bun.sleep(ms)
}

afterEach(() => {
  stopAllHealthChecks()
  delete process.env[MCP_HEALTH_CHECK_ENV]
})

describe('isMcpHealthCheckEnabled', () => {
  test('default off', () => {
    delete process.env[MCP_HEALTH_CHECK_ENV]
    expect(isMcpHealthCheckEnabled()).toBe(false)
  })

  test('on when the env gate is truthy', () => {
    process.env[MCP_HEALTH_CHECK_ENV] = '1'
    expect(isMcpHealthCheckEnabled()).toBe(true)
  })
})

describe('probeServerHealth', () => {
  test('healthy ping reports latency', async () => {
    const result = await probeServerHealth(makeClient(() => Promise.resolve()))
    expect(result.healthy).toBe(true)
    expect(result.unreachable).toBeUndefined()
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  test('rejected ping degrades to a structured unhealthy result', async () => {
    const result = await probeServerHealth(
      makeClient(() => Promise.reject(new Error('transport closed'))),
    )
    expect(result.healthy).toBe(false)
    expect(result.unreachable).toBe(true)
    expect(result.error).toBe('transport closed')
  })

  test('a ping that never settles is cut off by the hard timeout budget', async () => {
    const result = await probeServerHealth(
      makeClient(() => new Promise<void>(() => {})),
      30,
    )
    expect(result.healthy).toBe(false)
    expect(result.unreachable).toBe(true)
    expect(result.error).toContain('timed out')
  })

  test('a late-settling ping still reports healthy', async () => {
    const result = await probeServerHealth(
      makeClient(() => Bun.sleep(10).then(() => undefined)),
      500,
    )
    expect(result.healthy).toBe(true)
  })
})

describe('startHealthCheck failure accounting', () => {
  test('marks unhealthy after the consecutive-failure threshold, then recovers', async () => {
    let healthy = false
    const samples: MCPServerHealth[] = []
    const transitions: string[] = []
    const stop = startHealthCheck(
      'flaky',
      makeClient(() =>
        healthy ? Promise.resolve() : Promise.reject(new Error('down')),
      ),
      {
        intervalMs: 5,
        timeoutMs: 50,
        failureThreshold: 2,
        onUnhealthy: health => {
          transitions.push('unhealthy')
          samples.push(health)
        },
        onRecover: health => {
          transitions.push('recover')
          samples.push(health)
        },
      },
    )

    await flush(40)
    const unhealthySample = samples[0]
    expect(transitions[0]).toBe('unhealthy')
    expect(unhealthySample?.status).toBe('unhealthy')
    expect(unhealthySample?.failureCount).toBe(2)
    expect(unhealthySample?.lastError).toBe('down')
    expect(getServerHealth('flaky')?.status).toBe('unhealthy')

    // One more failure must NOT re-fire the transition (edge-triggered).
    const firedAfterMark = samples.length
    await flush(15)
    expect(samples.length).toBe(firedAfterMark)

    // Recovery flips the mark exactly once.
    healthy = true
    await flush(20)
    expect(transitions).toContain('recover')
    const recovered = samples[samples.length - 1]
    expect(recovered?.status).toBe('healthy')
    expect(recovered?.failureCount).toBe(0)

    stop()
  }, 5000)

  test('stopHealthCheck halts pinging (idempotent)', async () => {
    let pings = 0
    const stop = startHealthCheck(
      'stoppable',
      makeClient(() => {
        pings += 1
        return Promise.resolve()
      }),
      { intervalMs: 5, timeoutMs: 50 },
    )
    await flush(20)
    const atStop = pings
    stop()
    stop() // idempotent
    await flush(20)
    expect(pings).toBe(atStop)
  })

  test('restarting a server replaces its probe instead of stacking two', async () => {
    let pings = 0
    startHealthCheck(
      'restart-me',
      makeClient(() => {
        pings += 1
        return Promise.resolve()
      }),
      { intervalMs: 5, timeoutMs: 50 },
    )
    startHealthCheck(
      'restart-me',
      makeClient(() => {
        pings += 1
        return Promise.resolve()
      }),
      { intervalMs: 5, timeoutMs: 50 },
    )
    await flush(20)
    const before = pings
    await flush(15)
    // Two stacked probes would double the delta per tick.
    expect(pings - before).toBeLessThanOrEqual(4)
    stopAllHealthChecks()
  })

  test('stopAllHealthChecks clears every runtime', async () => {
    startHealthCheck(
      'all-1',
      makeClient(() => Promise.resolve()),
      { intervalMs: 5, timeoutMs: 50 },
    )
    startHealthCheck(
      'all-2',
      makeClient(() => Promise.resolve()),
      { intervalMs: 5, timeoutMs: 50 },
    )
    expect(getServerHealth('all-1')).toBeDefined()
    expect(getServerHealth('all-2')).toBeDefined()
    stopAllHealthChecks()
    expect(getServerHealth('all-1')).toBeUndefined()
    expect(getServerHealth('all-2')).toBeUndefined()
  })
})
