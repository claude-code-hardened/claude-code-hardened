/**
 * W6 (Q6) — health-mark exposure on the MCP status surface (predicate level;
 * the /mcp list row mirrors the healthCheck.ts runtime mark).
 */
import { describe, expect, test } from 'bun:test'

import {
  isServerHealthDisplayable,
  isServerHealthUnhealthy,
} from '../healthStatus.js'

function server(
  type: string,
  health?: { status: 'healthy' | 'unhealthy' },
): { client: { type: string; health?: { status: 'healthy' | 'unhealthy' } } } {
  return { client: { type, health } }
}

describe('isServerHealthUnhealthy', () => {
  test('connected + unhealthy mark → true', () => {
    expect(
      isServerHealthUnhealthy(
        server('connected', { status: 'unhealthy' }) as never,
      ),
    ).toBe(true)
  })

  test('connected + healthy mark → false', () => {
    expect(
      isServerHealthUnhealthy(
        server('connected', { status: 'healthy' }) as never,
      ),
    ).toBe(false)
  })

  test('connected without a health mark (probe opt-in) → false', () => {
    expect(isServerHealthUnhealthy({ client: { type: 'connected' } })).toBe(
      false,
    )
  })

  test('non-connected states never report unhealthy', () => {
    expect(
      isServerHealthUnhealthy(
        server('failed', { status: 'unhealthy' }) as never,
      ),
    ).toBe(false)
  })
})

describe('isServerHealthDisplayable', () => {
  test('healthy and mark-less connected servers display as connected', () => {
    expect(
      isServerHealthDisplayable(
        server('connected', { status: 'healthy' }) as never,
      ),
    ).toBe(true)
    expect(isServerHealthDisplayable({ client: { type: 'connected' } })).toBe(
      true,
    )
    expect(
      isServerHealthDisplayable(
        server('connected', { status: 'unhealthy' }) as never,
      ),
    ).toBe(false)
  })
})
