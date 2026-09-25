// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { toolMatchesName, type Tool, type Tools } from './Tool.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { isSearchExtraToolsEnabledOptimistic } from './utils/searchExtraTools.js'
import { isTodoV2Enabled } from './utils/tasks.js'
import type { ToolPermissionContext } from './Tool.js'
import { getDenyRuleForTool } from './utils/permissions/permissions.js'
import { hasEmbeddedSearchTools } from './utils/embeddedTools.js'
import {
  hasEmbeddedBfsPayload,
  hasEmbeddedUgrepPayload,
} from './utils/embeddedSearchTools.js'
import { isEnvTruthy } from './utils/envUtils.js'
import { isPowerShellToolEnabled } from './utils/shell/shellToolUtils.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'
import {
  REPL_TOOL_NAME,
  REPL_ONLY_TOOLS,
  isReplModeEnabled,
} from '@claude-code-hardened/builtin-tools/tools/REPLTool/constants.js'
export { REPL_ONLY_TOOLS }
export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
} from './constants/tools.js'
import { feature } from 'bun:bundle'

/**
 * Startup-lazy tool bodies. tools.ts is part of main.tsx's static import
 * closure, so every statically imported tool implementation (40+ modules,
 * most of which pull in @anthropic/ink for their renderUI) used to be
 * evaluated before commander parsed argv. Each getter below requires its
 * tool module on first call instead; require() caches the module, so
 * repeated calls are cheap. Exported tool-name constants (TOOL_PRESETS,
 * REPL_ONLY_TOOLS) and types stay static — only implementation modules are
 * deferred. Feature-gated loaders keep feature() in the same top-level
 * ternary position as before.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const getAgentTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/AgentTool/AgentTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/AgentTool/AgentTool.js')
  ).AgentTool
const getSkillTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/SkillTool/SkillTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/SkillTool/SkillTool.js')
  ).SkillTool
const getBashTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/BashTool/BashTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/BashTool/BashTool.js')
  ).BashTool
const getFileEditTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/FileEditTool/FileEditTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/FileEditTool/FileEditTool.js')
  ).FileEditTool
const getFileReadTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/FileReadTool/FileReadTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/FileReadTool/FileReadTool.js')
  ).FileReadTool
const getFileWriteTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/FileWriteTool/FileWriteTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/FileWriteTool/FileWriteTool.js')
  ).FileWriteTool
const getGlobTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/GlobTool/GlobTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/GlobTool/GlobTool.js')
  ).GlobTool
const getNotebookEditTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/NotebookEditTool/NotebookEditTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/NotebookEditTool/NotebookEditTool.js')
  ).NotebookEditTool
const getWebFetchTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/WebFetchTool/WebFetchTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/WebFetchTool/WebFetchTool.js')
  ).WebFetchTool
const getTaskStopTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/TaskStopTool/TaskStopTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/TaskStopTool/TaskStopTool.js')
  ).TaskStopTool
const getBriefTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/BriefTool/BriefTool.js')
  ).BriefTool
const getTaskOutputTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/TaskOutputTool/TaskOutputTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/TaskOutputTool/TaskOutputTool.js')
  ).TaskOutputTool
const getWebSearchTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/WebSearchTool/WebSearchTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/WebSearchTool/WebSearchTool.js')
  ).WebSearchTool
const getTodoWriteTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/TodoWriteTool/TodoWriteTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/TodoWriteTool/TodoWriteTool.js')
  ).TodoWriteTool
const getExitPlanModeV2Tool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js')
  ).ExitPlanModeV2Tool
const getArtifactTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/ArtifactTool/ArtifactTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ArtifactTool/ArtifactTool.js')
  ).ArtifactTool
const getTestingPermissionTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/testing/TestingPermissionTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/testing/TestingPermissionTool.js')
  ).TestingPermissionTool
const getGrepTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/GrepTool/GrepTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/GrepTool/GrepTool.js')
  ).GrepTool
const getTungstenTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/TungstenTool/TungstenTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/TungstenTool/TungstenTool.js')
  ).TungstenTool
const getAskUserQuestionTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/AskUserQuestionTool/AskUserQuestionTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/AskUserQuestionTool/AskUserQuestionTool.js')
  ).AskUserQuestionTool
const getLSPTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/LSPTool/LSPTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/LSPTool/LSPTool.js')
  ).LSPTool
const getListMcpResourcesTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/ListMcpResourcesTool/ListMcpResourcesTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ListMcpResourcesTool/ListMcpResourcesTool.js')
  ).ListMcpResourcesTool
const getReadMcpResourceTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/ReadMcpResourceTool/ReadMcpResourceTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ReadMcpResourceTool/ReadMcpResourceTool.js')
  ).ReadMcpResourceTool
const getSearchExtraToolsTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/SearchExtraToolsTool/SearchExtraToolsTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/SearchExtraToolsTool/SearchExtraToolsTool.js')
  ).SearchExtraToolsTool
const getExecuteTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/ExecuteTool/ExecuteTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ExecuteTool/ExecuteTool.js')
  ).ExecuteTool
const getEnterPlanModeTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/EnterPlanModeTool/EnterPlanModeTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/EnterPlanModeTool/EnterPlanModeTool.js')
  ).EnterPlanModeTool
const getEnterWorktreeTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/EnterWorktreeTool/EnterWorktreeTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/EnterWorktreeTool/EnterWorktreeTool.js')
  ).EnterWorktreeTool
const getExitWorktreeTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/ExitWorktreeTool/ExitWorktreeTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ExitWorktreeTool/ExitWorktreeTool.js')
  ).ExitWorktreeTool
const getConfigTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/ConfigTool/ConfigTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ConfigTool/ConfigTool.js')
  ).ConfigTool
const getLocalMemoryRecallTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/LocalMemoryRecallTool/LocalMemoryRecallTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/LocalMemoryRecallTool/LocalMemoryRecallTool.js')
  ).LocalMemoryRecallTool
const getVaultHttpFetchTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/VaultHttpFetchTool/VaultHttpFetchTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/VaultHttpFetchTool/VaultHttpFetchTool.js')
  ).VaultHttpFetchTool
const getTaskCreateTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/TaskCreateTool/TaskCreateTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/TaskCreateTool/TaskCreateTool.js')
  ).TaskCreateTool
const getTaskGetTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/TaskGetTool/TaskGetTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/TaskGetTool/TaskGetTool.js')
  ).TaskGetTool
const getTaskUpdateTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/TaskUpdateTool/TaskUpdateTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/TaskUpdateTool/TaskUpdateTool.js')
  ).TaskUpdateTool
const getTaskListTool = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/TaskListTool/TaskListTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/TaskListTool/TaskListTool.js')
  ).TaskListTool
const getSyntheticOutputToolName = () =>
  (
    require('@claude-code-hardened/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js')
  ).SYNTHETIC_OUTPUT_TOOL_NAME

// Dead code elimination: conditional loaders (feature() must stay in the
// top-level ternary condition for Bun's compiler).
const REPLToolLoader =
  process.env.USER_TYPE === 'ant'
    ? () =>
        (
          require('@claude-code-hardened/builtin-tools/tools/REPLTool/REPLTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/REPLTool/REPLTool.js')
        ).REPLTool
    : null
const SuggestBackgroundPRToolLoader =
  process.env.USER_TYPE === 'ant'
    ? () =>
        (
          require('@claude-code-hardened/builtin-tools/tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.js')
        ).SuggestBackgroundPRTool
    : null
const SleepToolLoader =
  feature('PROACTIVE') || feature('KAIROS')
    ? () =>
        (
          require('@claude-code-hardened/builtin-tools/tools/SleepTool/SleepTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/SleepTool/SleepTool.js')
        ).SleepTool
    : null
const getCronTools = (): Tool[] => [
  (
    require('@claude-code-hardened/builtin-tools/tools/ScheduleCronTool/CronCreateTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ScheduleCronTool/CronCreateTool.js')
  ).CronCreateTool,
  (
    require('@claude-code-hardened/builtin-tools/tools/ScheduleCronTool/CronDeleteTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ScheduleCronTool/CronDeleteTool.js')
  ).CronDeleteTool,
  (
    require('@claude-code-hardened/builtin-tools/tools/ScheduleCronTool/CronListTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ScheduleCronTool/CronListTool.js')
  ).CronListTool,
]
const RemoteTriggerToolLoader = feature('AGENT_TRIGGERS_REMOTE')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/RemoteTriggerTool/RemoteTriggerTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/RemoteTriggerTool/RemoteTriggerTool.js')
      ).RemoteTriggerTool
  : null
const MonitorToolLoader = feature('MONITOR_TOOL')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/MonitorTool/MonitorTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/MonitorTool/MonitorTool.js')
      ).MonitorTool
  : null
const SendUserFileToolLoader = feature('KAIROS')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/SendUserFileTool/SendUserFileTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/SendUserFileTool/SendUserFileTool.js')
      ).SendUserFileTool
  : null
const PushNotificationToolLoader =
  feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? () =>
        (
          require('@claude-code-hardened/builtin-tools/tools/PushNotificationTool/PushNotificationTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/PushNotificationTool/PushNotificationTool.js')
        ).PushNotificationTool
    : null
const SubscribePRToolLoader = feature('KAIROS_GITHUB_WEBHOOKS')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/SubscribePRTool/SubscribePRTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/SubscribePRTool/SubscribePRTool.js')
      ).SubscribePRTool
  : null

// Lazy require to break circular dependency: tools.ts -> TeamCreateTool/TeamDeleteTool -> ... -> tools.ts
const getTeamCreateTool = () =>
  require('@claude-code-hardened/builtin-tools/tools/TeamCreateTool/TeamCreateTool.js')
    .TeamCreateTool as typeof import('@claude-code-hardened/builtin-tools/tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
const getTeamDeleteTool = () =>
  require('@claude-code-hardened/builtin-tools/tools/TeamDeleteTool/TeamDeleteTool.js')
    .TeamDeleteTool as typeof import('@claude-code-hardened/builtin-tools/tools/TeamDeleteTool/TeamDeleteTool.js').TeamDeleteTool
const getSendMessageTool = () =>
  require('@claude-code-hardened/builtin-tools/tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool as typeof import('@claude-code-hardened/builtin-tools/tools/SendMessageTool/SendMessageTool.js').SendMessageTool

const GoalToolLoader = feature('GOAL')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/GoalTool/GoalTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/GoalTool/GoalTool.js')
      ).GoalTool
  : null
// Dead code elimination: conditional import for CLAUDE_CODE_VERIFY_PLAN
const VerifyPlanExecutionToolLoader =
  process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'
    ? () =>
        (
          require('@claude-code-hardened/builtin-tools/tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js')
        ).VerifyPlanExecutionTool
    : null
// Dead code elimination: conditional import for OVERFLOW_TEST_TOOL.
// No `typeof import` cast here: the module is a stub that only exports
// OVERFLOW_TEST_TOOL_NAME, so the original untyped require semantics are kept.
const OverflowTestToolLoader = feature('OVERFLOW_TEST_TOOL')
  ? () =>
      require('@claude-code-hardened/builtin-tools/tools/OverflowTestTool/OverflowTestTool.js')
        .OverflowTestTool
  : null
const CtxInspectToolLoader = feature('CONTEXT_COLLAPSE')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/CtxInspectTool/CtxInspectTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/CtxInspectTool/CtxInspectTool.js')
      ).CtxInspectTool
  : null
const TerminalCaptureToolLoader = feature('TERMINAL_PANEL')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/TerminalCaptureTool/TerminalCaptureTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/TerminalCaptureTool/TerminalCaptureTool.js')
      ).TerminalCaptureTool
  : null
const WebBrowserToolLoader = feature('WEB_BROWSER_TOOL')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/WebBrowserTool/WebBrowserTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/WebBrowserTool/WebBrowserTool.js')
      ).WebBrowserTool
  : null
const coordinatorModeModuleLoader = feature('COORDINATOR_MODE')
  ? () =>
      require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js')
  : null
const SnipToolLoader = feature('HISTORY_SNIP')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/SnipTool/SnipTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/SnipTool/SnipTool.js')
      ).SnipTool
  : null
const DiscoverSkillsToolLoader = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/DiscoverSkillsTool/DiscoverSkillsTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/DiscoverSkillsTool/DiscoverSkillsTool.js')
      ).DiscoverSkillsTool
  : null
const ReviewArtifactToolLoader = feature('REVIEW_ARTIFACT')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/ReviewArtifactTool/ReviewArtifactTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ReviewArtifactTool/ReviewArtifactTool.js')
      ).ReviewArtifactTool
  : null
const ListPeersToolLoader = feature('UDS_INBOX')
  ? () =>
      (
        require('@claude-code-hardened/builtin-tools/tools/ListPeersTool/ListPeersTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/ListPeersTool/ListPeersTool.js')
      ).ListPeersTool
  : null
const WorkflowToolLoader = feature('WORKFLOW_SCRIPTS')
  ? () =>
      (
        require('./workflow/wiring.js') as typeof import('./workflow/wiring.js')
      ).createWorkflowToolCore()
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
/* eslint-enable @typescript-eslint/no-require-imports */
const getPowerShellTool = () => {
  if (!isPowerShellToolEnabled()) return null
  return (
    require('@claude-code-hardened/builtin-tools/tools/PowerShellTool/PowerShellTool.js') as typeof import('@claude-code-hardened/builtin-tools/tools/PowerShellTool/PowerShellTool.js')
  ).PowerShellTool
}

/**
 * Predefined tool presets that can be used with --tools flag
 */
export const TOOL_PRESETS = ['default'] as const

export type ToolPreset = (typeof TOOL_PRESETS)[number]

export function parseToolPreset(preset: string): ToolPreset | null {
  const presetString = preset.toLowerCase()
  if (!TOOL_PRESETS.includes(presetString as ToolPreset)) {
    return null
  }
  return presetString as ToolPreset
}

/**
 * Get the list of tool names for a given preset
 * Filters out tools that are disabled via isEnabled() check
 * @param preset The preset name
 * @returns Array of tool names
 */
export function getToolsForDefaultPreset(): string[] {
  const tools = getAllBaseTools()
  const isEnabled = tools.map(tool => tool.isEnabled())
  return tools.filter((_, i) => isEnabled[i]).map(tool => tool.name)
}

/**
 * Get the complete exhaustive list of all tools that could be available
 * in the current environment (respecting process.env flags).
 * This is the source of truth for ALL tools.
 */
/**
 * NOTE: This MUST stay in sync with https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/claude_code_global_system_caching, in order to cache the system prompt across users.
 */
export function getAllBaseTools(): Tools {
  return [
    getAgentTool(),
    getTaskOutputTool(),
    getBashTool(),
    // bfs/ugrep embedded builds（同 ARGV0 分发）：shell 里 find/grep 被接管，
    // 被接管的专用工具移除。工具级降级 + SDK 排除双条件——开关关（含 SDK
    // 入口）或对应 payload 缺席（Windows 无 bfs）时保留专用工具。
    ...(!hasEmbeddedSearchTools() || !hasEmbeddedBfsPayload()
      ? [getGlobTool()]
      : []),
    ...(!hasEmbeddedSearchTools() || !hasEmbeddedUgrepPayload()
      ? [getGrepTool()]
      : []),
    getExitPlanModeV2Tool(),
    getFileReadTool(),
    getFileEditTool(),
    getFileWriteTool(),
    getNotebookEditTool(),
    getArtifactTool(),
    getWebFetchTool(),
    getTodoWriteTool(),
    getWebSearchTool(),
    getTaskStopTool(),
    getAskUserQuestionTool(),
    getSkillTool(),
    getEnterPlanModeTool(),
    getLocalMemoryRecallTool(),
    getVaultHttpFetchTool(),
    ...(process.env.USER_TYPE === 'ant' ? [getConfigTool()] : []),
    ...(GoalToolLoader ? [GoalToolLoader()] : []),
    ...(process.env.USER_TYPE === 'ant' ? [getTungstenTool()] : []),
    ...(SuggestBackgroundPRToolLoader ? [SuggestBackgroundPRToolLoader()] : []),
    ...(WebBrowserToolLoader ? [WebBrowserToolLoader()] : []),
    ...(isTodoV2Enabled()
      ? [
          getTaskCreateTool(),
          getTaskGetTool(),
          getTaskUpdateTool(),
          getTaskListTool(),
        ]
      : []),
    ...(OverflowTestToolLoader ? [OverflowTestToolLoader()] : []),
    ...(CtxInspectToolLoader ? [CtxInspectToolLoader()] : []),
    ...(TerminalCaptureToolLoader ? [TerminalCaptureToolLoader()] : []),
    ...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [getLSPTool()] : []),
    ...(isWorktreeModeEnabled()
      ? [getEnterWorktreeTool(), getExitWorktreeTool()]
      : []),
    getSendMessageTool(),
    ...(ListPeersToolLoader ? [ListPeersToolLoader()] : []),
    getTeamCreateTool(),
    getTeamDeleteTool(),
    ...(VerifyPlanExecutionToolLoader ? [VerifyPlanExecutionToolLoader()] : []),
    ...(process.env.USER_TYPE === 'ant' && REPLToolLoader
      ? [REPLToolLoader()]
      : []),
    ...(WorkflowToolLoader ? [WorkflowToolLoader()] : []),
    ...(SleepToolLoader ? [SleepToolLoader()] : []),
    ...getCronTools(),
    ...(RemoteTriggerToolLoader ? [RemoteTriggerToolLoader()] : []),
    ...(MonitorToolLoader ? [MonitorToolLoader()] : []),
    getBriefTool(),
    ...(SendUserFileToolLoader ? [SendUserFileToolLoader()] : []),
    ...(PushNotificationToolLoader ? [PushNotificationToolLoader()] : []),
    ...(SubscribePRToolLoader ? [SubscribePRToolLoader()] : []),
    ...(ReviewArtifactToolLoader ? [ReviewArtifactToolLoader()] : []),
    ...(getPowerShellTool() ? [getPowerShellTool()] : []),
    ...(SnipToolLoader ? [SnipToolLoader()] : []),
    ...(DiscoverSkillsToolLoader ? [DiscoverSkillsToolLoader()] : []),
    ...(process.env.NODE_ENV === 'test' ? [getTestingPermissionTool()] : []),
    getListMcpResourcesTool(),
    getReadMcpResourceTool(),
    // Include SearchExtraToolsTool when tool search might be enabled (optimistic check)
    // The actual decision to defer tools happens at request time in claude.ts
    ...(isSearchExtraToolsEnabledOptimistic()
      ? [getSearchExtraToolsTool()]
      : []),
    // ExecuteExtraTool (ExecuteTool) is a first-class tool — always available, not deferred.
    // Models use it to invoke deferred tools discovered via SearchExtraTools.
    getExecuteTool(),
  ]
}

/**
 * Filters out tools that are blanket-denied by the permission context.
 * A tool is filtered out if there's a deny rule matching its name with no
 * ruleContent (i.e., a blanket deny for that tool).
 *
 * Uses the same matcher as the runtime permission check (step 1a), so MCP
 * server-prefix rules like `mcp__server` strip all tools from that server
 * before the model sees them — not just at call time.
 */
export function filterToolsByDenyRules<
  T extends {
    name: string
    mcpInfo?: { serverName: string; toolName: string }
  },
>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}

export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // Simple mode: only Bash, Read, and Edit tools
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    // --bare + REPL mode: REPL wraps Bash/Read/Edit/etc inside the VM, so
    // return REPL instead of the raw primitives. Matches the non-bare path
    // below which also hides REPL_ONLY_TOOLS when REPL is enabled.
    if (isReplModeEnabled() && REPLToolLoader) {
      const replSimple: Tool[] = [REPLToolLoader()]
      if (
        feature('COORDINATOR_MODE') &&
        coordinatorModeModuleLoader?.().isCoordinatorMode()
      ) {
        replSimple.push(getTaskStopTool(), getSendMessageTool())
      }
      return filterToolsByDenyRules(replSimple, permissionContext)
    }
    const simpleTools: Tool[] = [
      getBashTool(),
      getFileReadTool(),
      getFileEditTool(),
    ]
    // When coordinator mode is also active, include AgentTool and TaskStopTool
    // so the coordinator gets Task+TaskStop (via useMergedTools filtering) and
    // workers get Bash/Read/Edit (via filterToolsForAgent filtering).
    if (
      feature('COORDINATOR_MODE') &&
      coordinatorModeModuleLoader?.().isCoordinatorMode()
    ) {
      simpleTools.push(getAgentTool(), getTaskStopTool(), getSendMessageTool())
    }
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // Get all base tools and filter out special tools that get added conditionally
  const specialTools = new Set([
    getListMcpResourcesTool().name,
    getReadMcpResourceTool().name,
    getSyntheticOutputToolName(),
  ])

  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))

  // Filter out tools that are denied by the deny rules
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // When REPL mode is enabled, hide primitive tools from direct use.
  // They're still accessible inside REPL via the VM context.
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(tool =>
      toolMatchesName(tool, REPL_TOOL_NAME),
    )
    if (replEnabled) {
      allowedTools = allowedTools.filter(
        tool => !REPL_ONLY_TOOLS.has(tool.name),
      )
    }
  }

  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}

/**
 * Assemble the full tool pool for a given permission context and MCP tools.
 *
 * This is the single source of truth for combining built-in tools with MCP tools.
 * Both REPL.tsx (via useMergedTools hook) and runAgent.ts (for coordinator workers)
 * use this function to ensure consistent tool pool assembly.
 *
 * The function:
 * 1. Gets built-in tools via getTools() (respects mode filtering)
 * 2. Filters MCP tools by deny rules
 * 3. Deduplicates by tool name (built-in tools take precedence)
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined, deduplicated array of built-in and MCP tools
 */
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)

  // Filter out MCP tools that are in the deny list
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // Sort each partition for prompt-cache stability, keeping built-ins as a
  // contiguous prefix. The server's claude_code_system_cache_policy places a
  // global cache breakpoint after the last prefix-matched built-in tool; a flat
  // sort would interleave MCP tools into built-ins and invalidate all downstream
  // cache keys whenever an MCP tool sorts between existing built-ins. uniqBy
  // preserves insertion order, so built-ins win on name conflict.
  // Avoid Array.toSorted (Node 20+) — we support Node 18. builtInTools is
  // readonly so copy-then-sort; allowedMcpTools is a fresh .filter() result.
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}

/**
 * Get all tools including both built-in tools and MCP tools.
 *
 * This is the preferred function when you need the complete tools list for:
 * - Tool search threshold calculations (isSearchExtraToolsEnabled)
 * - Token counting that includes MCP tools
 * - Any context where MCP tools should be considered
 *
 * Use getTools() only when you specifically need just built-in tools.
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined array of built-in and MCP tools
 */
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]
}
