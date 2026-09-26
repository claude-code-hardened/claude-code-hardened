import { describe, expect, test } from 'bun:test'
import {
  handleMessagingRequest,
  type SessionBridge,
} from '../messagingServer.js'

function makeBridge(overrides: Partial<SessionBridge> = {}): SessionBridge {
  return {
    send: async () => {},
    read: async (lines: number) =>
      Array.from({ length: lines }, (_, i) => `line-${i}`),
    alive: () => true,
    close: async () => {},
    meta: () => ({ engine: 'tmux', name: 'claude-bg-test' }),
    ...overrides,
  }
}

describe('handleMessagingRequest', () => {
  test('bad shape → EUNKNOWN', async () => {
    const resp = await handleMessagingRequest(makeBridge(), null as never)
    expect(resp.ok).toBe(false)
    expect(resp.code).toBe('EUNKNOWN')
  })

  test('send with empty text → EPROTO', async () => {
    const resp = await handleMessagingRequest(makeBridge(), {
      verb: 'send',
      text: '',
    })
    expect(resp.ok).toBe(false)
    expect(resp.code).toBe('EPROTO')
  })

  test('send forwards to bridge', async () => {
    let sent: string | undefined
    const resp = await handleMessagingRequest(
      makeBridge({
        send: async t => {
          sent = t
        },
      }),
      { verb: 'send', text: 'hello' },
    )
    expect(resp.ok).toBe(true)
    expect(sent).toBe('hello')
  })

  test('send failure → ESEND with message', async () => {
    const resp = await handleMessagingRequest(
      makeBridge({
        send: async () => {
          throw new Error('detached sessions do not accept input')
        },
      }),
      { verb: 'send', text: 'x' },
    )
    expect(resp.ok).toBe(false)
    expect(resp.code).toBe('ESEND')
    expect(resp.error).toContain('detached')
  })

  test('read returns lines array', async () => {
    const resp = await handleMessagingRequest(makeBridge(), {
      verb: 'read',
      lines: 3,
    })
    expect(resp.ok).toBe(true)
    expect((resp as { lines: number }).lines).toBe(3)
    expect((resp as { output: string[] }).output).toHaveLength(3)
  })

  test('status reports alive + engine meta', async () => {
    const resp = await handleMessagingRequest(makeBridge(), { verb: 'status' })
    expect(resp.ok).toBe(true)
    expect((resp as { alive: boolean }).alive).toBe(true)
    expect((resp as { engine: string }).engine).toBe('tmux')
  })

  test('close terminates and reports ok', async () => {
    let closed = false
    const resp = await handleMessagingRequest(
      makeBridge({
        close: async () => {
          closed = true
        },
      }),
      { verb: 'close' },
    )
    expect(resp.ok).toBe(true)
    expect(closed).toBe(true)
  })

  test('unknown verb → EUNKNOWN with hint', async () => {
    const resp = await handleMessagingRequest(makeBridge(), {
      verb: 'nope' as never,
    })
    expect(resp.ok).toBe(false)
    expect(resp.error).toContain('unknown verb')
  })
})
