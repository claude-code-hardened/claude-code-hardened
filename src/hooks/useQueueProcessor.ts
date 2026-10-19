import { useEffect, useSyncExternalStore } from 'react'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  hasUserIntentCommandsInQueue,
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../utils/messageQueueManager.js'
import type { QueryGuard } from '../utils/QueryGuard.js'
import { processQueueIfReady } from '../utils/queueProcessor.js'

/**
 * 官方 so() 唤醒门判定（module-006:9229 `so(){return g.some((Ro)=>
 * !_b(Ro)&&Ro.passive!==!0)}` 的 useQueueProcessor effect 前置三连）。
 * 抽出为纯函数供 W1.6 唤醒门测试直测（hook 本体不渲染可测）：
 * query 活跃 / 本地 JSX UI 占用 / 纯 passive 队列（isUserIntentCommand
 * 全 false）一律不 wake——纯 passive 队列留待下一个真实唤因随轮入上下文。
 */
export function shouldWakeQueueProcessor(params: {
  isQueryActive: boolean
  hasActiveLocalJsxUI: boolean
  hasUserIntentCommands: boolean
}): boolean {
  if (params.isQueryActive) return false
  if (params.hasActiveLocalJsxUI) return false
  return params.hasUserIntentCommands
}

type UseQueueProcessorParams = {
  executeQueuedInput: (commands: QueuedCommand[]) => Promise<void>
  hasActiveLocalJsxUI: boolean
  queryGuard: QueryGuard
}

/**
 * Hook that processes queued commands when conditions are met.
 *
 * Uses a single unified command queue (module-level store). Priority determines
 * processing order: 'now' > 'next' (user input) > 'later' (task notifications).
 * The dequeue() function handles priority ordering automatically.
 *
 * Processing triggers when:
 * - No query active (queryGuard — reactive via useSyncExternalStore)
 * - Queue has items
 * - No active local JSX UI blocking input
 */
export function useQueueProcessor({
  executeQueuedInput,
  hasActiveLocalJsxUI,
  queryGuard,
}: UseQueueProcessorParams): void {
  // Subscribe to the query guard. Re-renders when a query starts or ends
  // (or when reserve/cancelReservation transitions dispatching state).
  const isQueryActive = useSyncExternalStore(
    queryGuard.subscribe,
    queryGuard.getSnapshot,
  )

  // Subscribe to the unified command queue via useSyncExternalStore.
  // This guarantees re-render when the store changes, bypassing
  // React context propagation delays that cause missed notifications in Ink.
  const queueSnapshot = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  )

  useEffect(() => {
    // 官方 so() = hasUserIntentCommandsInQueue（module-006:9229）：passive
    // 通知（CCH #50/#52，如主会话 userResumeNotice）入上下文但不算 user
    // intent、不触发新 query 轮——纯 passive 队列不 wake，留待下一个真实
    // 唤因（用户输入/其他 task-notification）随轮入上下文。判定源在
    // shouldWakeQueueProcessor（W1.6 测试面直测同一函数）。
    if (
      !shouldWakeQueueProcessor({
        isQueryActive,
        hasActiveLocalJsxUI,
        hasUserIntentCommands: hasUserIntentCommandsInQueue(),
      })
    ) {
      return
    }

    // Reservation is now owned by handlePromptSubmit (inside executeUserInput's
    // try block). The sync chain executeQueuedInput → handlePromptSubmit →
    // executeUserInput → queryGuard.reserve() runs before the first real await,
    // so by the time React re-runs this effect (due to the dequeue-triggered
    // snapshot change), isQueryActive is already true (dispatching) and the
    // guard above returns early. handlePromptSubmit's finally releases the
    // reservation via cancelReservation() (no-op if onQuery already ran end()).
    processQueueIfReady({ executeInput: executeQueuedInput })
  }, [
    queueSnapshot,
    isQueryActive,
    executeQueuedInput,
    hasActiveLocalJsxUI,
    queryGuard,
  ])
}
