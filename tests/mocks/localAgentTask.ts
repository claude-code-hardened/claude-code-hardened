/**
 * Shared partial mock for src/tasks/LocalAgentTask/LocalAgentTask.tsx.
 *
 * WHY: agentToolUtils.test.ts and spawnWindowCleanup.test.ts both mock this
 * module with disjoint shapes (one side needs the async/foreground register
 * stubs for the spawn-window guard, the other needs killBulk fidelity for
 * teardownRunningAgentsOnQuit). Bun's mock.module is process-global
 * (last-write-wins), so whichever file ran last shrank the module for the
 * other, which is part of why the whole AgentTool group went red in one CI
 * pass (CI log /tmp/test1c.log:2771, 2790, 2812, 2831, 2850).
 *
 * This factory unifies both shapes:
 * - registerAsyncAgent / registerAgentForeground consult the exported
 *   `spawnRegistrationFailure` toggles so tests can force registration
 *   failures exactly like the old file-local `failMode`.
 * - killAllRunningAgentTasks mirrors the real implementation
 *   (LocalAgentTask.tsx:366-372): every running local_agent task is passed to
 *   killAsyncAgent(taskId, setAppState) and the setAppState updater runs once
 *   per kill (source of the setAppStateCalls count asserted in tests).
 */
export const spawnRegistrationFailure = { async: false, sync: false }

const killAsyncAgentCalls: string[] = []

const noop = () => {}

export function resetSpawnRegistrationFailure(): void {
  spawnRegistrationFailure.async = false
  spawnRegistrationFailure.sync = false
}

export function getKillAsyncAgentCalls(): string[] {
  return killAsyncAgentCalls
}

export function resetKillAsyncAgentCalls(): void {
  killAsyncAgentCalls.length = 0
}

function killAsyncAgent(
  taskId: string,
  setAppState?: (f: unknown) => void,
): void {
  // Real killAsyncAgent flips the task to 'killed' via one setAppState call.
  killAsyncAgentCalls.push(taskId)
  setAppState?.((prev: unknown) => prev)
}

export function localAgentTaskMock() {
  return {
    completeAgentTask: noop,
    createActivityDescriptionResolver: () => () => undefined,
    createProgressTracker: () => ({}),
    enqueueAgentNotification: noop,
    failAgentTask: noop,
    getProgressUpdate: () => ({ tokenCount: 0, toolUseCount: 0 }),
    getTokenCountFromTracker: () => 0,
    isLocalAgentTask: () => false,
    markAgentsNotified: noop,
    updateAgentProgress: noop,
    updateProgressFromMessage: noop,
    killAsyncAgent,
    killAllRunningAgentTasks: (
      tasks: Record<string, { type?: string; status?: string }>,
      setAppState: (f: unknown) => void,
    ): void => {
      for (const [taskId, task] of Object.entries(tasks)) {
        if (task.type === 'local_agent' && task.status === 'running') {
          killAsyncAgent(taskId, setAppState)
        }
      }
    },
    registerAsyncAgent: (_args: Record<string, unknown>) => {
      if (spawnRegistrationFailure.async) {
        throw new Error('register-async-failed')
      }
      return {
        agentId: 'bg-agent-id',
        abortController: new AbortController(),
      }
    },
    registerAgentForeground: (_args: Record<string, unknown>) => {
      if (spawnRegistrationFailure.sync) {
        throw new Error('register-foreground-failed')
      }
      return {
        taskId: 'fg-agent-id',
        backgroundSignal: new Promise<never>(() => {}),
        cancelAutoBackground: noop,
      }
    },
    unregisterAgentForeground: noop,
  }
}
