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
 *
 * 表面与真实模块对齐（回官方 :8420/:8428 后为纯进程内活表 + resume 咽喉
 * 单点补投；无磁盘快照/hydrate/全局补投面）。
 */
export const taskRegistryMock = {
  isTerminalHandleStatus: (status: string) =>
    status === 'completed' || status === 'failed',
  recordTaskHandle: () => ({}),
  recordTaskHeartbeat: () => {},
  recordTaskHeartbeats: () => {},
  getTaskHandleRecord: () => undefined,
  // CCH #52/#44: framework.ts 的 still-running 快照面读取的表视图。
  getAllTaskHandleRecords: () => [],
  getTaskRegistryDiagnostics: () => ({
    handles: [],
    undelivered: [],
    suspicious: [],
  }),
  peekUndeliveredTerminalTasks: () => [],
  reapSuspiciousTasks: () => [],
  // CCH 审查修复：官方 $M 单点补投咽喉（resumeAgent 显式复活点）。
  deliverOnResume: () => undefined,
}
