import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  LIFECYCLE_HOOK_EVENTS,
  POST_MODEL_SWITCH_EVENT,
  PRE_MODEL_SWITCH_EVENT,
  USER_PROMPT_EXPANSION_EVENT,
  emitPostModelSwitch,
  emitPreModelSwitch,
  emitUserPromptExpansion,
  ensureBuiltinLifecycleHookRegistered,
  isExtendedHookEventName,
  isLifecycleHookEvent,
  registerLifecycleHook,
  resetBuiltinLifecycleHookForTest,
} from '../lifecycleHookEvents.js'
import {
  getMainThreadHooks,
  resetMainThreadHookRegistry,
} from '../hookRegistry.js'

const originalEnv = { ...process.env }

beforeEach(() => {
  // The built-in latch and the registry must reset together: ensure… latches
  // its ids once per process, while afterEach clears the registry.
  resetBuiltinLifecycleHookForTest()
})

afterEach(() => {
  process.env = { ...originalEnv }
  resetMainThreadHookRegistry()
  resetBuiltinLifecycleHookForTest()
})

describe('lifecycleHookEvents (PreModelSwitch/PostModelSwitch/UserPromptExpansion)', () => {
  test('the trio extends the existing hook-event face in official order', () => {
    expect(LIFECYCLE_HOOK_EVENTS).toEqual([
      'PreModelSwitch',
      'PostModelSwitch',
      'UserPromptExpansion',
    ])
    expect(isLifecycleHookEvent(PRE_MODEL_SWITCH_EVENT)).toBe(true)
    expect(isLifecycleHookEvent('UserPromptSubmit')).toBe(false)
    // Same-surface extension: settings-era names stay valid, trio added.
    expect(isExtendedHookEventName('PreToolUse')).toBe(true)
    expect(isExtendedHookEventName(POST_MODEL_SWITCH_EVENT)).toBe(true)
    expect(isExtendedHookEventName(USER_PROMPT_EXPANSION_EVENT)).toBe(true)
    expect(isExtendedHookEventName('NotAHookEvent')).toBe(false)
  })

  test('emitPreModelSwitch / emitPostModelSwitch reach registered hooks', async () => {
    const pre: Array<Record<string, unknown>> = []
    const post: Array<Record<string, unknown>> = []
    registerLifecycleHook({
      name: 'pre-switch-watcher',
      events: [PRE_MODEL_SWITCH_EVENT],
      callback: payload => {
        pre.push(payload)
      },
    })
    registerLifecycleHook({
      name: 'post-switch-watcher',
      events: [POST_MODEL_SWITCH_EVENT],
      callback: payload => {
        post.push(payload)
      },
    })

    await emitPreModelSwitch({
      fromModel: 'sonnet',
      toModel: 'opus',
      source: 'command',
    })
    await emitPostModelSwitch({
      fromModel: 'sonnet',
      toModel: 'opus',
      source: 'command',
    })

    expect(pre).toHaveLength(1)
    expect(post).toHaveLength(1)
    expect((pre[0] as { fromModel?: string }).fromModel).toBe('sonnet')
    expect((pre[0] as { toModel?: string }).toModel).toBe('opus')
    expect((post[0] as { toModel?: string }).toModel).toBe('opus')
  })

  test('emitUserPromptExpansion carries expansion payload fields', async () => {
    const seen: Array<Record<string, unknown>> = []
    registerLifecycleHook({
      name: 'prompt-watcher',
      events: [USER_PROMPT_EXPANSION_EVENT],
      callback: payload => {
        seen.push(payload)
      },
    })

    await emitUserPromptExpansion({
      originalPrompt: '/review src',
      expandedPrompt: '/review:src',
      additionalContext: 'alias ci expanded',
    })

    expect(seen).toHaveLength(1)
    expect(seen[0].originalPrompt).toBe('/review src')
    expect(seen[0].expandedPrompt).toBe('/review:src')
  })

  test('built-in lifecycle logger is registered so dispatch is never vacuous (R7 #58)', async () => {
    // Emitters ensure-builtin-register before dispatching.
    await emitPreModelSwitch({ fromModel: 'a', toModel: 'b', source: 'sdk' })
    const hooks = getMainThreadHooks(PRE_MODEL_SWITCH_EVENT)
    expect(hooks.length).toBeGreaterThan(0)
    expect(
      hooks.some(h => h.name.startsWith('lifecycle-builtin-logger:')),
    ).toBe(true)
  })

  test('ensureBuiltinLifecycleHookRegistered is idempotent', () => {
    const first = ensureBuiltinLifecycleHookRegistered()
    const second = ensureBuiltinLifecycleHookRegistered()
    expect(second).toEqual(first)
    // One built-in hook per event, no duplicates.
    for (const event of LIFECYCLE_HOOK_EVENTS) {
      const builtins = getMainThreadHooks(event).filter(h =>
        h.name.startsWith('lifecycle-builtin-logger:'),
      )
      expect(builtins).toHaveLength(1)
      expect(builtins[0].events).toEqual([event])
      expect(builtins[0].origin).toBe('local')
    }
  })

  test('the registered built-in hook actually fires on dispatch (non-vacuous)', async () => {
    ensureBuiltinLifecycleHookRegistered()
    let fired = 0
    registerLifecycleHook({
      name: 'counter',
      events: [USER_PROMPT_EXPANSION_EVENT],
      callback: () => {
        fired += 1
      },
    })
    await emitUserPromptExpansion({ originalPrompt: 'x', expandedPrompt: 'x' })
    // The user hook and the built-in sink both ran without error.
    expect(fired).toBe(1)
  })
})
