import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
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
 * Kick the periodic gate check on mount and whenever the permission mode
 * changes (mirrors the auto-mode gate hook below).
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
    ).catch(error => {
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
