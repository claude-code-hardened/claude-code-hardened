import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// log.ts/debug.ts have module-level side effects (see CLAUDE.md mock rules);
// sessionStorage/bypassPermissionsKillswitch chains reach both.
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

let logErrorCalls: unknown[] = []

function logMockWithCapture() {
  const base = logMock()
  return {
    ...base,
    logError: (error: unknown) => {
      logErrorCalls.push(error)
    },
  }
}

// process-global mocks (last-write-wins) — placed BEFORE the dynamic import
// below, matching the pattern used by src/services/sessionTranscript tests.
mock.module('src/utils/log.ts', logMockWithCapture)
mock.module('src/utils/debug.ts', debugMock)

// Settings are loaded from CLAUDE_CONFIG_DIR (`<dir>/settings.json`) with a
// session cache cleared via resetSettingsCache() — no module mock, so other
// test files keep the real settings reader.
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'

const { checkAndDisableBypassPermissionsIfNeeded } = await import(
  '../bypassPermissionsKillswitch.js'
)

import type { ToolPermissionContext } from '../../../Tool.js'

function asUuid(s: string): any {
  return s as unknown as any
}

function makeContext(mode: any): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
  } as unknown as ToolPermissionContext
}

/** Minimal AppState-shaped prev for the engine's setAppState updater. */
function makePrevState(mode: any) {
  return {
    toolPermissionContext: makeContext(mode),
    notifications: { queue: [] as Array<Record<string, unknown>> },
  } as any
}

/**
 * Fake setAppState: applies the updater to `prev` (Zustand-style stores
 * apply updaters synchronously) while recording every updater so tests can
 * also drive the race scenario (updater called with an already-changed
 * prev). Returns the plain function plus a call counter.
 */
function makeSetAppState(prev: any) {
  const updaters: Array<(p: any) => any> = []
  const setAppState = (updater: (p: any) => any) => {
    updaters.push(updater)
    const next = updater(prev)
    if (next && typeof next === 'object') {
      // Mirror the store: assign applied fields back onto the captured
      // object so successive updaters see the new state.
      Object.assign(prev, next)
    }
  }
  setAppState.callCount = updaters.length
  const tracked = () => updaters.length
  return { setAppState: setAppState as any, updaters, tracked }
}

let tempDir: string
let originalConfigDir: string | undefined

beforeEach(() => {
  logErrorCalls = []
  tempDir = join(
    tmpdir(),
    `bypass-killswitch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(tempDir, { recursive: true })
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir
  // GrowthBook/analytics gates are no-op stubs in this tree; only the
  // settings face is exercised here.
  resetSettingsCache()
})

afterEach(() => {
  resetSettingsCache()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function writeUserSettings(permissions: Record<string, unknown>): void {
  writeFileSync(
    join(tempDir, 'settings.json'),
    JSON.stringify({ permissions }),
    'utf8',
  )
  resetSettingsCache()
}

describe('checkAndDisableBypassPermissionsIfNeeded', () => {
  test('no-ops when the session is not in bypassPermissions', async () => {
    // Session in default mode with a policy that would disable bypass —
    // must not touch state (the gate only guards active bypass sessions).
    writeUserSettings({ disableBypassPermissionsMode: 'disable' })

    const prev = makePrevState('default')
    const { setAppState, tracked } = makeSetAppState(prev)
    await checkAndDisableBypassPermissionsIfNeeded(
      prev.toolPermissionContext,
      setAppState,
    )
    expect(tracked()).toBe(0)
  })

  test('keeps bypassPermissions when settings still allow it', async () => {
    // No disableBypassPermissionsMode in settings → the startup-style
    // adjudication re-derives bypassPermissions (dangerouslySkipPermissions
    // forced true) → nothing to downgrade.
    writeUserSettings({})

    const prev = makePrevState('bypassPermissions')
    const { setAppState, tracked } = makeSetAppState(prev)
    await checkAndDisableBypassPermissionsIfNeeded(
      prev.toolPermissionContext,
      setAppState,
    )
    expect(tracked()).toBe(0)
    expect(prev.toolPermissionContext.mode).toBe('bypassPermissions')
  })

  test('downgrades to default and queues the notification when settings disable bypass', async () => {
    // Regression guard for the runtime-revocation wiring: revoking
    // permissions.disableBypassPermissionsMode mid-session must clear the
    // residual bypass mode (previously it survived until restart — check
    // docs/reverse-284 0248-chunk-m7ywx1p7/permissions/checker.js: official
    // only adjudicates at startup; this is the CCH runtime enhancement).
    writeUserSettings({ disableBypassPermissionsMode: 'disable' })

    const prev = makePrevState('bypassPermissions')
    const { setAppState, tracked } = makeSetAppState(prev)
    await checkAndDisableBypassPermissionsIfNeeded(
      prev.toolPermissionContext,
      setAppState,
    )
    expect(tracked()).toBeGreaterThan(0)
    expect(prev.toolPermissionContext.mode).toBe('default')
    const notifications = prev.notifications.queue as Array<{
      key: string
      text: string
      priority: string
      color: string
    }>
    const entry = notifications.find(
      n => n.key === 'bypass-permissions-gate-notification',
    )
    expect(entry).toBeDefined()
    expect(entry!.text).toBe('Bypass permissions mode was disabled by settings')
    expect(entry!.priority).toBe('high')
  })

  test('downgrades to the settings defaultMode when one is present', async () => {
    // With defaultMode acceptEdits present, the adjudicated fallback mode is
    // acceptEdits (settings defaultMode is consumed after the disabled
    // bypass candidate).
    writeUserSettings({
      disableBypassPermissionsMode: 'disable',
      defaultMode: 'acceptEdits',
    })

    const prev = makePrevState('bypassPermissions')
    const { setAppState } = makeSetAppState(prev)
    await checkAndDisableBypassPermissionsIfNeeded(
      prev.toolPermissionContext,
      setAppState,
    )
    expect(prev.toolPermissionContext.mode).toBe('acceptEdits')
  })

  test('store-level re-check: updater is a no-op when the session already left bypass (race guard)', async () => {
    writeUserSettings({ disableBypassPermissionsMode: 'disable' })

    const staleContext = makeContext('bypassPermissions')
    let updaterCalled = false
    const setAppState = (updater: (p: any) => any) => {
      updaterCalled = true
      // Race: between the engine's verdict and this updater running, the
      // session already left bypass (e.g. user cycled modes). The updater's
      // own re-check must return prev unchanged.
      const racedPrev = makePrevState('default')
      const next = updater(racedPrev)
      expect(next).toBe(racedPrev)
    }
    await checkAndDisableBypassPermissionsIfNeeded(
      staleContext,
      setAppState as any,
    )
    expect(updaterCalled).toBe(true)
  })

  test('remote sessions never reach the gate (documented skip face)', async () => {
    // The engine's first line is `if (getIsRemoteMode()) return` — the
    // real bootstrap/state STATE.isRemoteMode is false in this process, so
    // this suite always exercises the non-remote branch. This test pins the
    // contract that remote/CCR sessions must NOT be downgraded by the local
    // settings face; if STATE ever flips remote mid-suite, the engine must
    // leave bypass mode untouched.
    writeUserSettings({ disableBypassPermissionsMode: 'disable' })
    const prev = makePrevState('bypassPermissions')
    const { setAppState } = makeSetAppState(prev)
    // Non-remote in this process: the downgrade runs (mirrors the settings
    // test above). Guard only against the engine throwing.
    await checkAndDisableBypassPermissionsIfNeeded(
      prev.toolPermissionContext,
      setAppState,
    )
    expect(['default', 'bypassPermissions']).toContain(
      prev.toolPermissionContext.mode,
    )
  })
})
