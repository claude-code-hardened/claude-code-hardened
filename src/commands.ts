// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
// Startup-lazy command shims — see lazyCommand() below. Only the commands that
// participate in identity-based sets (REMOTE_SAFE_COMMANDS /
// BRIDGE_SAFE_COMMANDS, plus the login factory used by COMMANDS()) stay as
// static imports; everything else is deferred to first consumption.
import btw from './commands/btw/index.js'
import clear from './commands/clear/index.js'
import color from './commands/color/index.js'
import compact from './commands/compact/index.js'
import copy from './commands/copy/index.js'
import exit from './commands/exit/index.js'
import feedback from './commands/feedback/index.js'
import files from './commands/files/index.js'
import help from './commands/help/index.js'
import keybindings from './commands/keybindings/index.js'
import language from './commands/language/index.js'
import login from './commands/login/index.js'
import mobile from './commands/mobile/index.js'
import plan from './commands/plan/index.js'
import releaseNotes from './commands/release-notes/index.js'
import session from './commands/session/index.js'
import statusline from './commands/statusline.js'
import stickers from './commands/stickers/index.js'
import summary from './commands/summary/index.js'
import theme from './commands/theme/index.js'
import usage from './commands/usage/index.js'
import vim from './commands/vim/index.js'
import memoize from 'lodash-es/memoize.js'
import { logError } from './utils/log.js'
import { toError } from './utils/errors.js'
import { logForDebugging } from './utils/debug.js'
import { isUsing3PServices, isClaudeAISubscriber } from './utils/auth.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
  isThirdPartyAPIProvider,
} from './utils/model/providers.js'
import { t } from './i18n/index.js'

// Every shim's load() registers here so --check-commands (compile smoke) can
// force-load all of them and surface missing-bundle modules as a build-time
// failure instead of a runtime uncaughtException.
const allShims: (() => Command)[] = []

/**
 * Compile smoke: force-load every lazy shim. Any module missing from the
 * bundle throws ResolveMessage here, failing --check-commands with a nonzero
 * exit instead of crashing the REPL mid-session.
 */
export function forceLoadAllShims(): void {
  for (const load of allShims) {
    const cmd = load()
    if (!cmd || typeof (cmd as { name?: unknown }).name !== 'string') {
      throw new Error('lazy command shim resolved to a non-Command value')
    }
  }
}

/**
 * Startup-lazy command shim.
 *
 * commands.ts used to statically import ~120 command modules (9.4k lines plus
 * their dependency chains), all evaluated while main.tsx loads — i.e. before
 * commander even parses argv — although the objects are only consumed after
 * getCommands() runs (slash menu, skill tooling, non-interactive dispatch).
 * Each shim is a Proxy that defers its module's evaluation until the first
 * property access, then forwards everything to the real command object, so
 * the exported shape of this module and the Command objects' behavior are
 * unchanged.
 *
 * Call sites pass a **require thunk** (`() => require('./x.js')`), NOT a
 * module path string. Bun --compile only bundles modules reachable from the
 * static import graph; a `require(<variable>)` inside this function body
 * would stay a runtime lookup against $bunfs and 404 for every shim target
 * not otherwise statically imported (shipped as
 * "Cannot find module './commands/add-dir/index.js'"). A literal require at
 * the call site is statically scanned into the bundle while CJS cache
 * semantics keep evaluation deferred to the first load() — the lazy startup
 * behavior is preserved.
 *
 * Commands that participate in identity-based sets (REMOTE_SAFE_COMMANDS,
 * BRIDGE_SAFE_COMMANDS) must stay statically imported: Set.has() compares by
 * object identity and shims would not match objects imported directly from
 * their modules (tests do exactly that). Feature-gated require()s are also
 * left untouched.
 */
function lazyCommand(
  loadModule: () => unknown,
  exportName = 'default',
): Command {
  let cached: Command | undefined
  const load = (): Command => {
    if (!cached) {
      const mod = loadModule() as Record<string, unknown>
      cached = mod[exportName] as Command
    }
    return cached
  }
  allShims.push(load)
  return new Proxy({} as Command, {
    get(_target, prop) {
      const cmd = load()
      const value = Reflect.get(cmd, prop, cmd)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(cmd)
        : value
    },
    has(_target, prop) {
      return Reflect.has(load(), prop)
    },
    ownKeys() {
      return Reflect.ownKeys(load())
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(load(), prop)
      // Proxy invariant: the plain {} target has no own properties, so a
      // reported descriptor must claim configurability to avoid a TypeError.
      if (descriptor) descriptor.configurable = true
      return descriptor
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(load())
    },
    set(_target, prop, value) {
      return Reflect.set(load(), prop, value)
    },
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(load(), prop)
    },
  })
}

// Lazy shims (default exports unless a named export is given).
const addDir = lazyCommand(() => require('./commands/add-dir/index.js'))
const autofixPr = lazyCommand(() => require('./commands/autofix-pr/index.js'))
const backfillSessions = lazyCommand(() =>
  require('./commands/backfill-sessions/index.js'),
)
const goodClaude = lazyCommand(() => require('./commands/good-claude/index.js'))
const issue = lazyCommand(() => require('./commands/issue/index.js'))
const commit = lazyCommand(() => require('./commands/commit.js'))
const desktop = lazyCommand(() => require('./commands/desktop/index.js'))
const commitPushPr = lazyCommand(() => require('./commands/commit-push-pr.js'))
const config = lazyCommand(() => require('./commands/config/index.js'))
const context = lazyCommand(
  () => require('./commands/context/index.js'),
  'context',
)
const contextNonInteractive = lazyCommand(
  () => require('./commands/context/index.js'),
  'contextNonInteractive',
)
// cost/index.ts re-exports usage — /cost is now an alias of /usage
const diff = lazyCommand(() => require('./commands/diff/index.js'))
const doctor = lazyCommand(() => require('./commands/doctor/index.js'))
const memory = lazyCommand(() => require('./commands/memory/index.js'))
const mode = lazyCommand(() => require('./commands/mode/index.js'))
const ide = lazyCommand(() => require('./commands/ide/index.js'))
const init = lazyCommand(() => require('./commands/init.js'))
const initVerifiers = lazyCommand(() => require('./commands/init-verifiers.js'))
const lang = lazyCommand(() => require('./commands/lang/index.js'))
const logout = lazyCommand(() => require('./commands/logout/index.js'))
const installGitHubApp = lazyCommand(() =>
  require('./commands/install-github-app/index.js'),
)
const installSlackApp = lazyCommand(() =>
  require('./commands/install-slack-app/index.js'),
)
const breakCache = lazyCommand(() => require('./commands/break-cache/index.js'))
const breakCacheNonInteractive = lazyCommand(
  () => require('./commands/break-cache/index.js'),
  'breakCacheNonInteractive',
)
const mcp = lazyCommand(() => require('./commands/mcp/index.js'))
const onboarding = lazyCommand(() => require('./commands/onboarding/index.js'))
const pr_comments = lazyCommand(() =>
  require('./commands/pr_comments/index.js'),
)
const rename = lazyCommand(() => require('./commands/rename/index.js'))
const resume = lazyCommand(() => require('./commands/resume/index.js'))
const review = lazyCommand(() => require('./commands/review.js'))
const ultrareview = lazyCommand(
  () => require('./commands/review.js'),
  'ultrareview',
)
const share = lazyCommand(() => require('./commands/share/index.js'))
const skills = lazyCommand(() => require('./commands/skills/index.js'))
const tasks = lazyCommand(() => require('./commands/tasks/index.js'))
const teleport = lazyCommand(() => require('./commands/teleport/index.js'))
const agentsPlatform = lazyCommand(() =>
  require('./commands/agents-platform/index.js'),
)
const scheduleCommand = lazyCommand(() =>
  require('./commands/schedule/index.js'),
)
const memoryStoresCommand = lazyCommand(() =>
  require('./commands/memory-stores/index.js'),
)
const skillStoreCommand = lazyCommand(() =>
  require('./commands/skill-store/index.js'),
)
const vaultCommand = lazyCommand(() => require('./commands/vault/index.js'))
const localVaultCommand = lazyCommand(() =>
  require('./commands/local-vault/index.js'),
)
const localMemoryCommand = lazyCommand(() =>
  require('./commands/local-memory/index.js'),
)
const securityReview = lazyCommand(() =>
  require('./commands/security-review.js'),
)
const bughunter = lazyCommand(() => require('./commands/bughunter/index.js'))
const terminalSetup = lazyCommand(() =>
  require('./commands/terminalSetup/index.js'),
)
const status = lazyCommand(() => require('./commands/status/index.js'))
const webTools = lazyCommand(() => require('./commands/web-tools/index.js'))
import { feature } from 'bun:bundle'
// Dead code elimination: conditional imports
/* eslint-disable @typescript-eslint/no-require-imports */
const proactive =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./commands/proactive.js').default
    : null
const briefCommand =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? require('./commands/brief.js').default
    : null
const assistantCommand = feature('KAIROS')
  ? require('./commands/assistant/index.js').default
  : null
const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default
  : null
const remoteControlServerCommand = feature('BRIDGE_MODE')
  ? require('./commands/remoteControlServer/index.js').default
  : null
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
const monitorCmd = feature('MONITOR_TOOL')
  ? require('./commands/monitor.js').default
  : null
const coordinatorCmd = feature('COORDINATOR_MODE')
  ? require('./commands/coordinator.js').default
  : null
const forceSnip = feature('HISTORY_SNIP')
  ? require('./commands/force-snip.js').default
  : null
const workflowsCmd = feature('WORKFLOW_SCRIPTS')
  ? (
      require('./commands/workflows/index.js') as typeof import('./commands/workflows/index.js')
    ).default
  : null
const webCmd = feature('CCR_REMOTE_SETUP')
  ? (
      require('./commands/remote-setup/index.js') as typeof import('./commands/remote-setup/index.js')
    ).default
  : null
const clearSkillIndexCache = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (
      require('./services/skillSearch/localSearch.js') as typeof import('./services/skillSearch/localSearch.js')
    ).clearSkillIndexCache
  : null
const subscribePr = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('./commands/subscribe-pr.js').default
  : null
const ultraplan = feature('ULTRAPLAN')
  ? require('./commands/ultraplan.js').default
  : null
const torch = feature('TORCH') ? require('./commands/torch.js').default : null
const daemonCmd =
  feature('DAEMON') || feature('BG_SESSIONS')
    ? require('./commands/daemon/index.js').default
    : null
const jobCmd = feature('TEMPLATES')
  ? require('./commands/job/index.js').default
  : null
const peersCmd = feature('UDS_INBOX')
  ? (
      require('./commands/peers/index.js') as typeof import('./commands/peers/index.js')
    ).default
  : null
const attachCmd = feature('UDS_INBOX')
  ? require('./commands/attach/index.js').default
  : null
const detachCmd = feature('UDS_INBOX')
  ? require('./commands/detach/index.js').default
  : null
const sendCmd = feature('UDS_INBOX')
  ? require('./commands/send/index.js').default
  : null
const pipesCmd = feature('UDS_INBOX')
  ? require('./commands/pipes/index.js').default
  : null
const pipeStatusCmd = feature('UDS_INBOX')
  ? require('./commands/pipe-status/index.js').default
  : null
const historyCmd = feature('UDS_INBOX')
  ? require('./commands/history/index.js').default
  : null
const claimMainCmd = feature('UDS_INBOX')
  ? require('./commands/claim-main/index.js').default
  : null
const forkCmd = feature('FORK_SUBAGENT')
  ? (
      require('./commands/fork/index.js') as typeof import('./commands/fork/index.js')
    ).default
  : null
const buddy = feature('BUDDY')
  ? (
      require('./commands/buddy/index.js') as typeof import('./commands/buddy/index.js')
    ).default
  : null
const poor = feature('POOR')
  ? (
      require('./commands/poor/index.js') as typeof import('./commands/poor/index.js')
    ).default
  : null
const goalCmd = feature('GOAL')
  ? (
      require('./commands/goal/index.js') as typeof import('./commands/goal/index.js')
    ).default
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
const thinkback = lazyCommand(() => require('./commands/thinkback/index.js'))
const thinkbackPlay = lazyCommand(() =>
  require('./commands/thinkback-play/index.js'),
)
const permissions = lazyCommand(() =>
  require('./commands/permissions/index.js'),
)
const fast = lazyCommand(() => require('./commands/fast/index.js'))
const passes = lazyCommand(() => require('./commands/passes/index.js'))
const privacySettings = lazyCommand(() =>
  require('./commands/privacy-settings/index.js'),
)
const hooks = lazyCommand(() => require('./commands/hooks/index.js'))
const branch = lazyCommand(() => require('./commands/branch/index.js'))
const artifacts = lazyCommand(() => require('./commands/artifacts/index.js'))
const agents = lazyCommand(() => require('./commands/agents/index.js'))
const plugin = lazyCommand(() => require('./commands/plugin/index.js'))
const reloadPlugins = lazyCommand(() =>
  require('./commands/reload-plugins/index.js'),
)
const rewind = lazyCommand(() => require('./commands/rewind/index.js'))
const heapDump = lazyCommand(() => require('./commands/heapdump/index.js'))
const mockLimits = lazyCommand(() => require('./commands/mock-limits/index.js'))
const bridgeKick = lazyCommand(() => require('./commands/bridge-kick.js'))
const version = lazyCommand(() => require('./commands/version.js'))
const recap = lazyCommand(() => require('./commands/recap/index.js'))
const skillLearning = lazyCommand(() =>
  require('./commands/skill-learning/index.js'),
)
const skillSearch = lazyCommand(() =>
  require('./commands/skill-search/index.js'),
)
const resetLimits = lazyCommand(() =>
  require('./commands/reset-limits/index.js'),
)
const resetLimitsNonInteractive = lazyCommand(
  () => require('./commands/reset-limits/index.js'),
  'resetLimitsNonInteractive',
)
const antTrace = lazyCommand(() => require('./commands/ant-trace/index.js'))
const perfIssue = lazyCommand(() => require('./commands/perf-issue/index.js'))
const sandboxToggle = lazyCommand(() =>
  require('./commands/sandbox-toggle/index.js'),
)
const tui = lazyCommand(() => require('./commands/tui/index.js'))
const tuiNonInteractive = lazyCommand(
  () => require('./commands/tui/index.js'),
  'tuiNonInteractive',
)
const chrome = lazyCommand(() => require('./commands/chrome/index.js'))
const advisor = lazyCommand(() => require('./commands/advisor.js'))
const autonomy = lazyCommand(() => require('./commands/autonomy.js'))
const provider = lazyCommand(() => require('./commands/provider.js'))
import {
  getSkillDirCommands,
  clearSkillCaches,
  getDynamicSkills,
} from './skills/loadSkillsDir.js'
import { getBundledSkills } from './skills/bundledSkills.js'
import { getBuiltinPluginSkillCommands } from './plugins/builtinPlugins.js'
import {
  getPluginCommands,
  clearPluginCommandCache,
  getPluginSkills,
  clearPluginSkillsCache,
} from './utils/plugins/loadPluginCommands.js'
const env = lazyCommand(() => require('./commands/env/index.js'))
const exportCommand = lazyCommand(() => require('./commands/export/index.js'))
const model = lazyCommand(() => require('./commands/model/index.js'))
const tag = lazyCommand(() => require('./commands/tag/index.js'))
const outputStyle = lazyCommand(() =>
  require('./commands/output-style/index.js'),
)
const remoteEnv = lazyCommand(() => require('./commands/remote-env/index.js'))
const upgrade = lazyCommand(() => require('./commands/upgrade/index.js'))
// extra-usage/index.ts has no default export — both commands are named.
const extraUsage = lazyCommand(
  () => require('./commands/extra-usage/index.js'),
  'extraUsage',
)
const extraUsageNonInteractive = lazyCommand(
  () => require('./commands/extra-usage/index.js'),
  'extraUsageNonInteractive',
)
const rateLimitOptions = lazyCommand(() =>
  require('./commands/rate-limit-options/index.js'),
)
const effort = lazyCommand(() => require('./commands/effort/index.js'))
// stats/index.ts re-exports usage — /stats is now an alias of /usage
// insights.ts is 113KB (3200 lines, includes diffLines/html rendering). Lazy
// shim defers the heavy module until /insights is actually invoked.
const usageReport: Command = {
  type: 'prompt',
  name: 'insights',
  description: t('Generate a report analyzing your Claude Code sessions'),
  contentLength: 0,
  progressMessage: t('analyzing your sessions'),
  source: 'builtin',
  async getPromptForCommand(args, context) {
    const real = (await import('./commands/insights.js')).default
    if (real.type !== 'prompt') throw new Error('unreachable')
    return real.getPromptForCommand(args, context)
  },
}
const oauthRefresh = lazyCommand(() =>
  require('./commands/oauth-refresh/index.js'),
)
const debugToolCall = lazyCommand(() =>
  require('./commands/debug-tool-call/index.js'),
)
import { getSettingSourceName } from './utils/settings/constants.js'
import { profileCheckpoint } from './utils/startupProfiler.js'
import {
  type Command,
  getCommandName,
  isCommandEnabled,
} from './types/command.js'

// Re-export types from the centralized location
export type {
  Command,
  CommandBase,
  CommandResultDisplay,
  LocalCommandResult,
  LocalJSXCommandContext,
  PromptCommand,
  ResumeEntrypoint,
} from './types/command.js'
export { getCommandName, isCommandEnabled } from './types/command.js'

// Commands that get eliminated from the external build
// Public-but-previously-locked commands moved to the main COMMANDS array below:
//   commit, commitPushPr, bridgeKick, initVerifiers, autofixPr, onboarding
// Remaining items here are truly Anthropic-internal (admin/diagnostics endpoints
// with no fork backend), so they only show up under USER_TYPE=ant.
export const INTERNAL_ONLY_COMMANDS = [
  backfillSessions,
  bughunter,
  goodClaude,
  mockLimits,
  resetLimits,
  resetLimitsNonInteractive,
  antTrace,
  oauthRefresh,
].filter(Boolean)

// Declared as a function so that we don't run this until getCommands is called,
// since underlying functions read from config, which can't be read at module initialization time
const COMMANDS = memoize((): Command[] => [
  addDir,
  advisor,
  agentsPlatform,
  scheduleCommand,
  memoryStoresCommand,
  skillStoreCommand,
  vaultCommand,
  localVaultCommand,
  localMemoryCommand,
  autonomy,
  provider,
  artifacts,
  agents,
  branch,
  btw,
  chrome,
  clear,
  color,
  compact,
  config,
  copy,
  desktop,
  context,
  contextNonInteractive,
  diff,
  doctor,
  effort,
  exit,
  fast,
  files,
  heapDump,
  help,
  ide,
  init,
  keybindings,
  lang,
  language,
  installGitHubApp,
  installSlackApp,
  mcp,
  memory,
  mobile,
  mode,
  model,
  outputStyle,
  remoteEnv,
  plugin,
  pr_comments,
  releaseNotes,
  reloadPlugins,
  rename,
  resume,
  session,
  skills,
  status,
  statusline,
  stickers,
  tag,
  theme,
  feedback,
  review,
  ultrareview,
  rewind,
  securityReview,
  terminalSetup,
  upgrade,
  extraUsage,
  extraUsageNonInteractive,
  rateLimitOptions,
  usage,
  usageReport,
  vim,
  webTools,
  ...(webCmd ? [webCmd] : []),
  ...(forkCmd ? [forkCmd] : []),
  ...(buddy ? [buddy] : []),
  ...(poor ? [poor] : []),
  ...(goalCmd ? [goalCmd] : []),
  ...(proactive ? [proactive] : []),
  ...(monitorCmd ? [monitorCmd] : []),
  ...(coordinatorCmd ? [coordinatorCmd] : []),
  ...(briefCommand ? [briefCommand] : []),
  ...(assistantCommand ? [assistantCommand] : []),
  ...(bridge ? [bridge] : []),
  ...(remoteControlServerCommand ? [remoteControlServerCommand] : []),
  ...(voiceCommand ? [voiceCommand] : []),
  thinkback,
  thinkbackPlay,
  permissions,
  plan,
  privacySettings,
  hooks,
  exportCommand,
  sandboxToggle,
  ...(!isUsing3PServices() ? [logout, login()] : []),
  passes,
  ...(peersCmd ? [peersCmd] : []),
  ...(attachCmd ? [attachCmd] : []),
  ...(detachCmd ? [detachCmd] : []),
  ...(sendCmd ? [sendCmd] : []),
  ...(pipesCmd ? [pipesCmd] : []),
  ...(pipeStatusCmd ? [pipeStatusCmd] : []),
  ...(historyCmd ? [historyCmd] : []),
  ...(claimMainCmd ? [claimMainCmd] : []),
  tasks,
  ...(workflowsCmd ? [workflowsCmd] : []),
  ...(ultraplan ? [ultraplan] : []),
  ...(torch ? [torch] : []),
  ...(daemonCmd ? [daemonCmd] : []),
  ...(jobCmd ? [jobCmd] : []),
  ...(forceSnip ? [forceSnip] : []),
  summary,
  recap,
  skillLearning,
  skillSearch,
  autofixPr,
  commit,
  commitPushPr,
  bridgeKick,
  version,
  ...(subscribePr ? [subscribePr] : []),
  initVerifiers,
  env,
  debugToolCall,
  perfIssue,
  breakCache,
  breakCacheNonInteractive,
  issue,
  share,
  teleport,
  tui,
  tuiNonInteractive,
  onboarding,
  ...(process.env.USER_TYPE === 'ant' && !process.env.IS_DEMO
    ? INTERNAL_ONLY_COMMANDS
    : []),
])

export const builtInCommandNames = memoize(
  (): Set<string> =>
    new Set(COMMANDS().flatMap(_ => [_.name, ...(_.aliases ?? [])])),
)

async function getSkills(cwd: string): Promise<{
  skillDirCommands: Command[]
  pluginSkills: Command[]
  bundledSkills: Command[]
  builtinPluginSkills: Command[]
}> {
  try {
    const [skillDirCommands, pluginSkills] = await Promise.all([
      getSkillDirCommands(cwd).catch(err => {
        logError(toError(err))
        logForDebugging(
          'Skill directory commands failed to load, continuing without them',
        )
        return []
      }),
      getPluginSkills().catch(err => {
        logError(toError(err))
        logForDebugging('Plugin skills failed to load, continuing without them')
        return []
      }),
    ])
    // Bundled skills are registered synchronously at startup
    const bundledSkills = getBundledSkills()
    // Built-in plugin skills come from enabled built-in plugins
    const builtinPluginSkills = getBuiltinPluginSkillCommands()
    logForDebugging(
      `getSkills returning: ${skillDirCommands.length} skill dir commands, ${pluginSkills.length} plugin skills, ${bundledSkills.length} bundled skills, ${builtinPluginSkills.length} builtin plugin skills`,
    )
    return {
      skillDirCommands,
      pluginSkills,
      bundledSkills,
      builtinPluginSkills,
    }
  } catch (err) {
    // This should never happen since we catch at the Promise level, but defensive
    logError(toError(err))
    logForDebugging('Unexpected error in getSkills, returning empty')
    return {
      skillDirCommands: [],
      pluginSkills: [],
      bundledSkills: [],
      builtinPluginSkills: [],
    }
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const getWorkflowCommands = feature('WORKFLOW_SCRIPTS')
  ? (
      require('./workflow/namedWorkflowCommands.js') as typeof import('./workflow/namedWorkflowCommands.js')
    ).getWorkflowCommands
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Filters commands by their declared `availability` (auth/provider requirement).
 * Commands without `availability` are treated as universal.
 * This runs before `isEnabled()` so that provider-gated commands are hidden
 * regardless of feature-flag state.
 *
 * Not memoized — auth state can change mid-session (e.g. after /login),
 * so this must be re-evaluated on every getCommands() call.
 */
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability || cmd.availability.length === 0) return true
  for (const a of cmd.availability) {
    switch (a) {
      case 'claude-ai':
        if (isClaudeAISubscriber()) return true
        break
      case 'console':
        // Console API key user = direct 1P API customer (not 3P, not claude.ai).
        // Excludes non-first-party providers selected through settings or env,
        // plus gateway users who proxy through a custom base URL.
        if (
          !isClaudeAISubscriber() &&
          !isThirdPartyAPIProvider(getAPIProvider()) &&
          isFirstPartyAnthropicBaseUrl()
        )
          return true
        break
      default: {
        const _exhaustive: never = a
        void _exhaustive
        break
      }
    }
  }
  return false
}

/**
 * Loads all command sources (skills, plugins, workflows). Memoized by cwd
 * because loading is expensive (disk I/O, dynamic imports).
 */
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
    workflowCommands,
  ] = await Promise.all([
    getSkills(cwd),
    getPluginCommands(),
    getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
  ])
  profileCheckpoint('commands_sources_loaded')

  return [
    ...bundledSkills,
    ...builtinPluginSkills,
    ...skillDirCommands,
    ...(workflowCommands as Command[]),
    ...(pluginCommands as Command[]),
    ...pluginSkills,
    ...COMMANDS(),
  ]
})

/**
 * Returns commands available to the current user. The expensive loading is
 * memoized, but availability and isEnabled checks run fresh every call so
 * auth changes (e.g. /login) take effect immediately.
 */
export async function getCommands(cwd: string): Promise<Command[]> {
  const allCommands = await loadAllCommands(cwd)

  // Get dynamic skills discovered during file operations
  const dynamicSkills = getDynamicSkills()

  // Build base commands without dynamic skills
  const baseCommands = allCommands.filter(
    _ => meetsAvailabilityRequirement(_) && isCommandEnabled(_),
  )
  profileCheckpoint('commands_filter_done')

  if (dynamicSkills.length === 0) {
    return baseCommands
  }

  // Dedupe dynamic skills - only add if not already present
  const baseCommandNames = new Set(baseCommands.map(c => c.name))
  const uniqueDynamicSkills = dynamicSkills.filter(
    s =>
      !baseCommandNames.has(s.name) &&
      meetsAvailabilityRequirement(s) &&
      isCommandEnabled(s),
  )

  if (uniqueDynamicSkills.length === 0) {
    return baseCommands
  }

  // Insert dynamic skills after plugin skills but before built-in commands
  const builtInNames = new Set(COMMANDS().map(c => c.name))
  const insertIndex = baseCommands.findIndex(c => builtInNames.has(c.name))

  if (insertIndex === -1) {
    return [...baseCommands, ...uniqueDynamicSkills]
  }

  return [
    ...baseCommands.slice(0, insertIndex),
    ...uniqueDynamicSkills,
    ...baseCommands.slice(insertIndex),
  ]
}

/**
 * Clears only the memoization caches for commands, WITHOUT clearing skill caches.
 * Use this when dynamic skills are added to invalidate cached command lists.
 */
export function clearCommandMemoizationCaches(): void {
  loadAllCommands.cache?.clear?.()
  getSkillToolCommands.cache?.clear?.()
  getSlashCommandToolSkills.cache?.clear?.()
  // getSkillIndex in skillSearch/localSearch.ts is a separate memoization layer
  // built ON TOP of getSkillToolCommands/getCommands. Clearing only the inner
  // caches is a no-op for the outer — lodash memoize returns the cached result
  // without ever reaching the cleared inners. Must clear it explicitly.
  clearSkillIndexCache?.()
}

export function clearCommandsCache(): void {
  clearCommandMemoizationCaches()
  clearPluginCommandCache()
  clearPluginSkillsCache()
  clearSkillCaches()
}

/**
 * Filter AppState.mcp.commands to MCP-provided skills (prompt-type,
 * model-invocable, loaded from MCP). These live outside getCommands() so
 * callers that need MCP skills in their skill index thread them through
 * separately.
 */
export function getMcpSkillCommands(
  mcpCommands: readonly Command[],
): readonly Command[] {
  if (feature('MCP_SKILLS')) {
    return mcpCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        cmd.loadedFrom === 'mcp' &&
        !cmd.disableModelInvocation,
    )
  }
  return []
}

// SkillTool shows ALL prompt-based commands that the model can invoke
// This includes both skills (from /skills/) and commands (from /commands/)
export const getSkillToolCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const allCommands = await getCommands(cwd)
    return allCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        !cmd.disableModelInvocation &&
        cmd.source !== 'builtin' &&
        // Always include skills from /skills/ dirs, bundled skills, and legacy /commands/ entries
        // (they all get an auto-derived description from the first line if frontmatter is missing).
        // Plugin/MCP commands still require an explicit description to appear in the listing.
        (cmd.loadedFrom === 'bundled' ||
          cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'commands_DEPRECATED' ||
          cmd.hasUserSpecifiedDescription ||
          cmd.whenToUse),
    )
  },
)

// Filters commands to include only skills. Skills are commands that provide
// specialized capabilities for the model to use. They are identified by
// loadedFrom being 'skills', 'plugin', or 'bundled', or having disableModelInvocation set.
export const getSlashCommandToolSkills = memoize(
  async (cwd: string): Promise<Command[]> => {
    try {
      const allCommands = await getCommands(cwd)
      return allCommands.filter(
        cmd =>
          cmd.type === 'prompt' &&
          cmd.source !== 'builtin' &&
          (cmd.hasUserSpecifiedDescription || cmd.whenToUse) &&
          (cmd.loadedFrom === 'skills' ||
            cmd.loadedFrom === 'plugin' ||
            cmd.loadedFrom === 'bundled' ||
            cmd.disableModelInvocation),
      )
    } catch (error) {
      logError(toError(error))
      // Return empty array rather than throwing - skills are non-critical
      // This prevents skill loading failures from breaking the entire system
      logForDebugging('Returning empty skills array due to load failure')
      return []
    }
  },
)

/**
 * Commands that are safe to use in remote mode (--remote).
 * These only affect local TUI state and don't depend on local filesystem,
 * git, shell, IDE, MCP, or other local execution context.
 *
 * Used in two places:
 * 1. Pre-filtering commands in main.tsx before REPL renders (prevents race with CCR init)
 * 2. Preserving local-only commands in REPL's handleRemoteInit after CCR filters
 */
export const REMOTE_SAFE_COMMANDS: Set<Command> = new Set([
  session, // Shows QR code / URL for remote session
  exit, // Exit the TUI
  clear, // Clear screen
  help, // Show help
  theme, // Change terminal theme
  language, // Change UI display language
  color, // Change agent color
  vim, // Toggle vim mode
  usage, // Show session cost, plan usage, and activity stats (/cost and /stats are aliases)
  copy, // Copy last message
  btw, // Quick note
  feedback, // Send feedback
  plan, // Plan mode toggle
  proactive, // Toggle proactive mode
  keybindings, // Keybinding management
  statusline, // Status line toggle
  stickers, // Stickers
  mobile, // Mobile QR code
])

/**
 * Builtin commands of type 'local' that ARE safe to execute when received
 * over the Remote Control bridge. These produce text output that streams
 * back to the mobile/web client and have no terminal-only side effects.
 *
 * 'local-jsx' commands are blocked by type (they render Ink UI) and
 * 'prompt' commands are allowed by type (they expand to text sent to the
 * model) — this set only gates 'local' commands.
 *
 * When adding a new 'local' command that should work from mobile, add it
 * here. Default is blocked.
 */
export const BRIDGE_SAFE_COMMANDS: Set<Command> = new Set(
  [
    compact, // Shrink context — useful mid-session from a phone
    clear, // Wipe transcript
    usage, // Show session cost (/cost alias)
    summary, // Summarize conversation
    releaseNotes, // Show changelog
    files, // List tracked files
  ].filter((c): c is Command => c !== null),
)

/**
 * Whether a slash command is safe to execute when its input arrived over the
 * Remote Control bridge (mobile/web client).
 *
 * PR #19134 blanket-blocked all slash commands from bridge inbound because
 * `/model` from iOS was popping the local Ink picker. This predicate relaxes
 * that with an explicit allowlist: 'prompt' commands (skills) expand to text
 * and are safe by construction; 'local' commands need an explicit opt-in via
 * BRIDGE_SAFE_COMMANDS; 'local-jsx' commands render Ink UI and stay blocked.
 */
export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'local-jsx') return cmd.bridgeSafe === true
  if (cmd.type === 'prompt') return true
  return cmd.bridgeSafe === true || BRIDGE_SAFE_COMMANDS.has(cmd)
}

export function getBridgeCommandSafety(
  cmd: Command,
  args: string,
): { ok: true } | { ok: false; reason?: string } {
  if (!isBridgeSafeCommand(cmd)) return { ok: false }
  const reason = cmd.getBridgeInvocationError?.(args)
  return reason ? { ok: false, reason } : { ok: true }
}

/**
 * Filter commands to only include those safe for remote mode.
 * Used to pre-filter commands when rendering the REPL in --remote mode,
 * preventing local-only commands from being briefly available before
 * the CCR init message arrives.
 */
export function filterCommandsForRemoteMode(commands: Command[]): Command[] {
  return commands.filter(cmd => REMOTE_SAFE_COMMANDS.has(cmd))
}

export function findCommand(
  commandName: string,
  commands: Command[],
): Command | undefined {
  return commands.find(
    _ =>
      _.name === commandName ||
      getCommandName(_) === commandName ||
      _.aliases?.includes(commandName),
  )
}

export function hasCommand(commandName: string, commands: Command[]): boolean {
  return findCommand(commandName, commands) !== undefined
}

export function getCommand(commandName: string, commands: Command[]): Command {
  const command = findCommand(commandName, commands)
  if (!command) {
    throw ReferenceError(
      `Command ${commandName} not found. Available commands: ${commands
        .map(_ => {
          const name = getCommandName(_)
          return _.aliases ? `${name} (aliases: ${_.aliases.join(', ')})` : name
        })
        .sort((a, b) => a.localeCompare(b))
        .join(', ')}`,
    )
  }

  return command
}

/**
 * Formats a command's description with its source annotation for user-facing UI.
 * Use this in typeahead, help screens, and other places where users need to see
 * where a command comes from.
 *
 * For model-facing prompts (like SkillTool), use cmd.description directly.
 */
export function formatDescriptionWithSource(cmd: Command): string {
  if (cmd.type !== 'prompt') {
    return cmd.description
  }

  if (cmd.kind === 'workflow') {
    return `${cmd.description} (workflow)`
  }

  if (cmd.source === 'plugin') {
    const pluginName = cmd.pluginInfo?.pluginManifest.name
    if (pluginName) {
      return `(${pluginName}) ${cmd.description}`
    }
    return `${cmd.description} (plugin)`
  }

  if (cmd.source === 'builtin' || cmd.source === 'mcp') {
    return cmd.description
  }

  if (cmd.source === 'bundled') {
    return `${cmd.description} (bundled)`
  }

  return `${cmd.description} (${getSettingSourceName(cmd.source)})`
}
