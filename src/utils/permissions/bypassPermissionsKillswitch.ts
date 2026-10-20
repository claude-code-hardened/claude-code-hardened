import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import {
  getIsRemoteMode,
  getSessionBypassPermissionsMode,
  setSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../../state/AppState.js'
import type { ToolPermissionContext } from '../../Tool.js'
import {
  initialPermissionModeFromCLI,
  verifyAutoModeGateAccess,
} from './permissionSetup.js'

/**
 * Periodic bypass-permissions gate. Reuses the startup-mode adjudication
 * (`initialPermissionModeFromCLI` — the single source that folds the statsig
 * org-policy gate + `permissions.disableBypassPermissionsMode` settings, so
 * the official notification copy "Bypass permissions mode was disabled by
 * your organization policy" / "...by settings" stays defined in one place).
 * While a session sits in bypassPermissions and the policy verdict is no
 * longer bypass, downgrades to the adjudicated mode (settings defaultMode,
 * else 'default') and surfaces the notification on the existing queue face.
 */
export async function checkAndDisableBypassPermissionsIfNeeded(
  toolPermissionContext: ToolPermissionContext,
  setAppState: (
    f: (
      prev: import('../../state/AppState.js').AppState,
    ) => import('../../state/AppState.js').AppState,
  ) => void,
): Promise<void> {
  if (getIsRemoteMode()) return
  if (toolPermissionContext.mode !== 'bypassPermissions') return

  // Periodic read: fresh settings + gate verdict on every invocation. The
  // bypass candidate is forced (`dangerouslySkipPermissions: true`) so that
  // exactly the startup disabled-by-policy/settings branch is adjudicated.
  const { mode, notification } = initialPermissionModeFromCLI({
    permissionModeCli: undefined,
    dangerouslySkipPermissions: true,
  })
  if (mode === 'bypassPermissions') {
    // Policy still allows bypass right now — nothing to downgrade.
    return
  }

  setAppState(prev => {
    // Re-check under the store: the session may have left bypass meanwhile.
    if (prev.toolPermissionContext.mode !== 'bypassPermissions') return prev
    const downgraded = {
      ...prev,
      toolPermissionContext: { ...prev.toolPermissionContext, mode },
    }
    if (!notification) return downgraded
    return {
      ...downgraded,
      notifications: {
        ...downgraded.notifications,
        queue: [
          ...downgraded.notifications.queue,
          {
            key: 'bypass-permissions-gate-notification',
            text: notification,
            color: 'warning' as const,
            priority: 'high' as const,
          },
        ],
      },
    }
  })
}

/**
 * Kept for interface compatibility — the periodic read above is stateless
 * (fresh verdict on every call), so there is nothing to reset.
 */
export function resetBypassPermissionsCheck(): void {
  // No-op
}

/**
 * Kick the bypass-revocation gate on mount and whenever the permission mode
 * changes (mirrors the auto-mode gate hook below).
 *
 * Official anchoring (docs/reverse-284, 0248-chunk-m7ywx1p7/permissions/
 * checker.js — `FLr`): official 2.8.4 adjudicates the bypass policy gate
 * ONCE at startup and has no runtime re-check face. Wiring this hook is a
 * CCH safety enhancement that fulfils the intent already declared in this
 * module's code (settings/organizational-policy revocation of an
 * in-flight bypass session); it deliberately does NOT invent a polling
 * loop — the check re-runs only on mount and on permission-mode changes,
 * with the store-level re-check below guarding against races.
 */
export function useKickOffCheckAndDisableBypassPermissionsIfNeeded(): void {
  const contextMode = useAppState(s => s.toolPermissionContext.mode)
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  useEffect(() => {
    if (getIsRemoteMode()) return
    void checkAndDisableBypassPermissionsIfNeeded(
      store.getState().toolPermissionContext,
      setAppState,
    )
      .then(() => {
        // Sync the session-global bypass flag (main.tsx writes it once at
        // startup via setSessionBypassPermissionsMode). If the gate
        // downgraded the live session out of bypass, re-check the store
        // and clear the stale flag so downstream readers (claude-in-chrome
        // setup, swarm spawn) observe the revocation without a restart.
        if (
          store.getState().toolPermissionContext.mode !== 'bypassPermissions' &&
          getSessionBypassPermissionsMode()
        ) {
          setSessionBypassPermissionsMode(false)
        }
      })
      .catch(error => {
        logError(
          new Error('Bypass permissions gate check failed', {
            cause: toError(error),
          }),
        )
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMode])
}

let autoModeCheckRan = false

export async function checkAndDisableAutoModeIfNeeded(
  toolPermissionContext: ToolPermissionContext,
  setAppState: (
    f: (
      prev: import('../../state/AppState.js').AppState,
    ) => import('../../state/AppState.js').AppState,
  ) => void,
  fastMode?: boolean,
): Promise<void> {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (autoModeCheckRan) {
      return
    }
    autoModeCheckRan = true

    const { updateContext, notification } = await verifyAutoModeGateAccess(
      toolPermissionContext,
      fastMode,
    )
    setAppState(prev => {
      const nextCtx = updateContext(prev.toolPermissionContext)
      const newState =
        nextCtx === prev.toolPermissionContext
          ? prev
          : { ...prev, toolPermissionContext: nextCtx }
      if (!notification) return newState
      return {
        ...newState,
        notifications: {
          ...newState.notifications,
          queue: [
            ...newState.notifications.queue,
            {
              key: 'auto-mode-gate-notification',
              text: notification,
              color: 'warning' as const,
              priority: 'high' as const,
            },
          ],
        },
      }
    })
  }
}

/**
 * Reset the run-once flag for checkAndDisableAutoModeIfNeeded.
 * Call this after /login so the gate check re-runs with the new org.
 */
export function resetAutoModeGateCheck(): void {
  autoModeCheckRan = false
}

export function useKickOffCheckAndDisableAutoModeIfNeeded(): void {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const fastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const isFirstRunRef = useRef(true)

  // Runs on mount (startup check) AND whenever the model or fast mode changes
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false
    } else {
      resetAutoModeGateCheck()
    }
    void checkAndDisableAutoModeIfNeeded(
      store.getState().toolPermissionContext,
      setAppState,
      fastMode,
    ).catch(error => {
      logError(
        new Error('Auto mode gate check failed', { cause: toError(error) }),
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainLoopModel, mainLoopModelForSession, fastMode])
}
