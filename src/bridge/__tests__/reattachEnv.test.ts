import { afterEach, describe, expect, test } from 'bun:test'
import {
  BRIDGE_REATTACH_OUTBOUND_ONLY_ENV,
  BRIDGE_REATTACH_SESSION_ENV,
  consumeBridgeReattachEnv,
  isBridgeReattachOutboundOnly,
  peekBridgeReattachSession,
  resetBridgeReattachEnv,
} from '../reattachEnv.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  resetBridgeReattachEnv()
})

describe('reattachEnv (CLAUDE_BRIDGE_REATTACH_SESSION/OUTBOUND_ONLY)', () => {
  test('unset env yields no reattach target and outbound-only off', () => {
    delete process.env[BRIDGE_REATTACH_SESSION_ENV]
    delete process.env[BRIDGE_REATTACH_OUTBOUND_ONLY_ENV]
    resetBridgeReattachEnv()

    expect(peekBridgeReattachSession()).toBeUndefined()
    expect(isBridgeReattachOutboundOnly()).toBe(false)

    const env = consumeBridgeReattachEnv()
    expect(env.sessionId).toBeUndefined()
    expect(env.outboundOnly).toBe(false)
  })

  test('consume reads the reattach session and deletes the raw vars (official read-and-forget)', () => {
    process.env[BRIDGE_REATTACH_SESSION_ENV] = 'session-abc'
    process.env[BRIDGE_REATTACH_OUTBOUND_ONLY_ENV] = '1'
    resetBridgeReattachEnv()

    expect(peekBridgeReattachSession()).toBe('session-abc')

    const env = consumeBridgeReattachEnv()
    expect(env.sessionId).toBe('session-abc')
    expect(env.outboundOnly).toBe(true)

    // Vars are deleted after read so respawned children don't reattach.
    expect(process.env[BRIDGE_REATTACH_SESSION_ENV]).toBeUndefined()
    expect(process.env[BRIDGE_REATTACH_OUTBOUND_ONLY_ENV]).toBeUndefined()
  })

  test('consume deletes the unread sibling vars with the session (official full-family scrub)', () => {
    const siblings = [
      'CLAUDE_BRIDGE_REATTACH_SEQ',
      'CLAUDE_BRIDGE_REATTACH_GROUPING',
      'CLAUDE_BRIDGE_REATTACH_OWNER_ACCT',
      'CLAUDE_BRIDGE_REATTACH_OWNER_ORG',
      'CLAUDE_BRIDGE_REATTACH_NO_BACKFILL',
    ] as const
    process.env[BRIDGE_REATTACH_SESSION_ENV] = 'session-abc'
    for (const s of siblings) process.env[s] = 'stale'
    resetBridgeReattachEnv()

    consumeBridgeReattachEnv()
    for (const s of siblings) {
      expect(process.env[s]).toBeUndefined()
    }
  })

  test('consume does NOT scrub OUTBOUND_ONLY when no session is set (official if(oe) gate)', () => {
    delete process.env[BRIDGE_REATTACH_SESSION_ENV]
    process.env[BRIDGE_REATTACH_OUTBOUND_ONLY_ENV] = '1'
    resetBridgeReattachEnv()

    const env = consumeBridgeReattachEnv()
    expect(env.sessionId).toBeUndefined()
    // Without a reattach session the official snapshot never enters the
    // delete branch — the var must survive for the actual consumer.
    expect(process.env[BRIDGE_REATTACH_OUTBOUND_ONLY_ENV]).toBe('1')
    // The latch still freezes the value for this process.
    expect(isBridgeReattachOutboundOnly()).toBe(true)
  })

  test('consume is idempotent — first call wins', () => {
    process.env[BRIDGE_REATTACH_SESSION_ENV] = 'first-session'
    resetBridgeReattachEnv()

    const first = consumeBridgeReattachEnv()
    process.env[BRIDGE_REATTACH_SESSION_ENV] = 'second-session'
    const second = consumeBridgeReattachEnv()

    expect(first.sessionId).toBe('first-session')
    expect(second.sessionId).toBe('first-session')
  })

  test('outbound-only flag survives the var deletion via the consumed latch', () => {
    process.env[BRIDGE_REATTACH_SESSION_ENV] = 'session-xyz'
    process.env[BRIDGE_REATTACH_OUTBOUND_ONLY_ENV] = 'true'
    resetBridgeReattachEnv()

    consumeBridgeReattachEnv()
    expect(isBridgeReattachOutboundOnly()).toBe(true)
    expect(process.env[BRIDGE_REATTACH_OUTBOUND_ONLY_ENV]).toBeUndefined()
  })

  test('blank session value is treated as unset', () => {
    process.env[BRIDGE_REATTACH_SESSION_ENV] = '   '
    resetBridgeReattachEnv()

    expect(peekBridgeReattachSession()).toBeUndefined()
    const env = consumeBridgeReattachEnv()
    expect(env.sessionId).toBeUndefined()
  })
})
