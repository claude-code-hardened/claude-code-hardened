import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearMainThreadHooks,
  dispatchMainThreadHookEvent,
  getMainThreadHooks,
  hasMainThreadHooks,
  registerMainThreadHook,
  removeMainThreadHook,
  replaceMainThreadHook,
  resetMainThreadHookRegistry,
} from '../hookRegistry.js'
const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  resetMainThreadHookRegistry()
})

describe('hookRegistry (main-thread registry)', () => {
  test('register / replace / clear API round-trips', async () => {
    const seen: string[] = []
    const id = registerMainThreadHook({
      name: 'collector',
      events: ['PreModelSwitch'],
      callback: payload => {
        seen.push(String((payload as { toModel?: string }).toModel))
      },
    })
    expect(hasMainThreadHooks('PreModelSwitch')).toBe(true)
    expect(getMainThreadHooks('PreModelSwitch')).toHaveLength(1)

    // Replace keeps the id, swaps the callback.
    expect(
      replaceMainThreadHook(id, {
        callback: payload => {
          seen.push(
            `replaced:${String((payload as { toModel?: string }).toModel)}`,
          )
        },
      }),
    ).toBe(true)
    expect(replaceMainThreadHook('no-such-id', {})).toBe(false)

    await dispatchMainThreadHookEvent('PreModelSwitch', { toModel: 'opus' })
    expect(seen).toEqual(['replaced:opus'])

    expect(removeMainThreadHook(id)).toBe(true)
    expect(clearMainThreadHooks('PreModelSwitch')).toBe(0)
    expect(hasMainThreadHooks('PreModelSwitch')).toBe(false)
  })

  test('dispatch fires only hooks registered for the event', async () => {
    const fired: string[] = []
    registerMainThreadHook({
      name: 'model-watch',
      events: ['PreModelSwitch'],
      callback: () => {
        fired.push('model-watch')
      },
    })
    registerMainThreadHook({
      name: 'prompt-watch',
      events: ['UserPromptExpansion'],
      callback: () => {
        fired.push('prompt-watch')
      },
    })

    await dispatchMainThreadHookEvent('UserPromptExpansion', {})
    expect(fired).toEqual(['prompt-watch'])

    await dispatchMainThreadHookEvent('PreModelSwitch', {})
    expect(fired).toEqual(['prompt-watch', 'model-watch'])
  })

  test('forwarded dispatch drops hooks when CLAUDE_CODE_DISABLE_HOOK_FORWARDING is set', async () => {
    const fired: string[] = []
    registerMainThreadHook({
      name: 'relay',
      events: ['PostModelSwitch'],
      callback: () => {
        fired.push('relay')
      },
    })

    // Local dispatch is never gated.
    await dispatchMainThreadHookEvent('PostModelSwitch', {})
    expect(fired).toEqual(['relay'])

    process.env.CLAUDE_CODE_DISABLE_HOOK_FORWARDING = '1'
    await dispatchMainThreadHookEvent(
      'PostModelSwitch',
      {},
      { forwarded: true },
    )
    expect(fired).toEqual(['relay'])
  })

  test('plugin-origin hooks are skipped for forwarded dispatch under CLAUDE_CODE_DISABLE_PLUGIN_FORWARDING, but still run locally', async () => {
    const fired: string[] = []
    registerMainThreadHook({
      name: 'plugin-relay',
      origin: 'plugin',
      events: ['PostModelSwitch'],
      callback: () => {
        fired.push('plugin-relay')
      },
    })

    process.env.CLAUDE_CODE_DISABLE_PLUGIN_FORWARDING = '1'
    await dispatchMainThreadHookEvent(
      'PostModelSwitch',
      {},
      { forwarded: true },
    )
    expect(fired).toEqual([])

    await dispatchMainThreadHookEvent('PostModelSwitch', {})
    expect(fired).toEqual(['plugin-relay'])
  })

  test('a throwing hook does not break the remaining dispatch', async () => {
    const fired: string[] = []
    registerMainThreadHook({
      name: 'boom',
      events: ['PreModelSwitch'],
      callback: () => {
        throw new Error('boom')
      },
    })
    registerMainThreadHook({
      name: 'after-boom',
      events: ['PreModelSwitch'],
      callback: () => {
        fired.push('after-boom')
      },
    })

    await dispatchMainThreadHookEvent('PreModelSwitch', {})
    expect(fired).toEqual(['after-boom'])
  })

  test('dispatch returns handler verdicts (W7 round 2 item 5)', async () => {
    registerMainThreadHook({
      name: 'policy-hook',
      events: ['PreModelSwitch'],
      callback: () => ({
        permissionDecision: 'deny',
        permissionDecisionReason: 'nope',
      }),
    })
    registerMainThreadHook({
      name: 'silent-hook',
      events: ['PreModelSwitch'],
      // void return — must not produce a verdict entry.
      callback: () => {},
    })
    registerMainThreadHook({
      name: 'allow-hook',
      events: ['PreModelSwitch'],
      callback: () => ({ permissionDecision: 'allow' }),
    })

    const results = await dispatchMainThreadHookEvent('PreModelSwitch', {})
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      hook: 'policy-hook',
      verdict: { permissionDecision: 'deny', permissionDecisionReason: 'nope' },
    })
    expect(results[1]).toMatchObject({
      hook: 'allow-hook',
      verdict: { permissionDecision: 'allow' },
    })
  })
})
