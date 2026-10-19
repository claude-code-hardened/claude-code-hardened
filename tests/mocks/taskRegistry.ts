/**
 * Shared stub for src/services/taskRegistry/taskRegistry.ts.
 *
 * The real registry pulls the bootstrap/envUtils side-effect chain
 * (realpathSync at import), which poisons suites that mock the AgentTool
 * dependency layers (resumeAgent etc. — dynamic imports hang / error on the
 * unmocked chain). Use with mock.module before importing modules that
 * transitively import the registry (e.g. runAgent.ts):
 *
 *   import { taskRegistryMock } from '...tests/mocks/taskRegistry'
 *   mock.module('src/services/taskRegistry/taskRegistry.js', () => taskRegistryMock)
 */
export const taskRegistryMock = {
  isTerminalHandleStatus: (status: string) =>
    status === 'completed' || status === 'failed',
  sanitizeTaskHandleId: (id: string) => id,
  getTaskSnapshotPath: (taskId: string) =>
    `/tmp/mocked-task-registry/${taskId}.state.json`,
  recordTaskHandle: () => () => {},
  recordTaskHeartbeat: () => {},
  recordTaskHeartbeats: () => {},
  getTaskHandleRecord: () => undefined,
  // CCH #52/#44: framework.ts 的 still-running 快照面读取的表视图。
  getAllTaskHandleRecords: () => [],
  hydrateTaskRegistry: () => {},
  getTaskRegistryDiagnostics: () => ({
    handles: [],
    undelivered: [],
    suspicious: [],
  }),
  consumeUndeliveredTerminalTasks: () => [],
  peekUndeliveredTerminalTasks: () => [],
  reapSuspiciousTasks: () => [],
}
