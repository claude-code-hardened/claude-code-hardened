/**
 * fuse.js 7.3.0 vs 7.5.0 差分对拍（library-level, 纯计算零依赖）
 *
 * 背景：7.5.0 修复了 4 个评分/排序 bug（#830 fieldNorm 空白分词、
 * #833 keys 权重归一化、#835 limit tie 修条目集、#831 minMatchCharLength 门）。
 * 官方定性 bug fix，排序变化是刻意的。本仓有三个 Fuse 消费点，其
 * threshold / score-epsilon 都是按 7.3 的分数标度调的，7.5 下分数
 * 被非线性推向 1，需要按对拍数据重校准。
 *
 * 运行：bun run scripts/fuse-differential.ts
 *
 * setup：两版库从 npmmirror tarball 解压（可用 FUSE73_DIR / FUSE75_DIR 覆盖
 * 路径，脚本找 <dir>/package/dist/fuse.mjs）：
 *   mkdir -p /tmp/fuse73 /tmp/fuse75
 *   curl -sL https://registry.npmmirror.com/fuse.js/-/fuse.js-7.3.0.tgz | tar xz -C /tmp/fuse73
 *   curl -sL https://registry.npmmirror.com/fuse.js/-/fuse.js-7.5.0.tgz | tar xz -C /tmp/fuse75
 *   bun run scripts/fuse-differential.ts
 *
 * 每个消费点输出：
 *  ① top-1 一致性（7.5@旧阈值 vs 7.3 基线）
 *  ② 命中集差异（7.5 丢失/新增哪些条目）
 *  ③ 排序翻转对数（common 条目中相对顺序不同的 pair 数）
 *  ④ 阈值扫描：7.5 下哪个 threshold 最接近 7.3 基线
 *  ⑤ epsilon 扫描（仅 commands 配置）：custom-sort 决策最接近 7.3 的值
 */

import { existsSync } from 'node:fs'

const FUSE73_DIR = process.env.FUSE73_DIR ?? '/tmp/fuse73'
const FUSE75_DIR = process.env.FUSE75_DIR ?? '/tmp/fuse75'

// 缺库即早失败并打印 setup 提示（避免 import 报错让人摸不着头脑）
for (const [tag, dir] of [
  ['7.3.0', FUSE73_DIR],
  ['7.5.0', FUSE75_DIR],
] as const) {
  if (!existsSync(`${dir}/package/dist/fuse.mjs`)) {
    console.error(`✗ fuse.js ${tag} 未找到: ${dir}/package/dist/fuse.mjs`)
    console.error('  按本文件头 setup 注释解压两版 tarball 后重跑')
    process.exit(1)
  }
}

type AnyFuse = new (
  items: unknown[],
  options: Record<string, unknown>,
) => {
  search: (
    query: string,
    opts?: Record<string, unknown>,
  ) => Array<{ item: unknown; score?: number; refIndex?: number }>
}

type Hit = { id: string; score: number }

// ─────────────────────────────────────────────────────────────────────
// 数据集：模拟本仓三处消费点的条目结构
// ─────────────────────────────────────────────────────────────────────

/** 消费点 1：commandSuggestions.getCommandFuse（4 键 3/2/2/0.5，threshold 0.3） */
type CommandItem = {
  commandName: string
  partKey: string[] | undefined
  aliasKey: string[] | undefined
  descriptionKey: string[]
}

function toCommandItem(
  commandName: string,
  description: string,
  aliases: string[] = [],
): CommandItem {
  const parts = commandName.split(/[:_-]/g).filter(Boolean)
  return {
    commandName,
    partKey: parts.length > 1 ? parts : undefined,
    aliasKey: aliases.length > 0 ? aliases : undefined,
    // 镜像 commandSuggestions.ts 的 cleanWord：
    // word.toLowerCase().replace(/[^a-z0-9]/g, '')
    descriptionKey: description
      .split(' ')
      .map(word => word.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(Boolean),
  }
}

// ~50 条，模拟本仓 slash 命令生态（内置命令 + sdd-* prompt 命令 + 插件命令）
const COMMAND_RAW: Array<[string, string, string[]?]> = [
  ['commit', 'commit staged changes with git and create a commit message'],
  ['compact', 'compact the conversation context to free tokens'],
  ['clear', 'clear the conversation history and reset context'],
  ['config', 'open the settings file in your editor'],
  ['context', 'show current context usage and memory files'],
  ['cost', 'show the total cost and duration of the current session'],
  ['doctor', 'diagnose and verify installation health'],
  ['help', 'show help and available commands'],
  ['init', 'initialize a new project with CLAUDE.md scaffold'],
  ['install-github-app', 'set up GitHub app for repository integration'],
  ['login', 'sign in with your Anthropic account'],
  ['logout', 'sign out from the current session'],
  ['mcp', 'manage Model Context Protocol servers'],
  ['memory', 'edit CLAUDE.md memory files with an editor'],
  ['model', 'select or change the AI model'],
  ['plugin', 'manage plugins marketplace and installations'],
  ['release-notes', 'view release notes for the current version'],
  ['resume', 'resume a previous conversation'],
  ['review', 'review a pull request or code changes'],
  ['setup-token', 'set up a long-lived authentication token'],
  ['status', 'show version and system status'],
  ['terminal-setup', 'install key bindings for your terminal'],
  ['usage', 'show plan usage limits'],
  ['vim', 'toggle vim keybinding mode'],
  ['ide', 'manage IDE integrations'],
  ['agents', 'manage subagent configurations'],
  ['agent-create', 'create a new subagent from a template'],
  ['auto-mode', 'toggle autonomous permission mode'],
  ['server', 'start the API server'],
  ['ssh', 'connect to a remote host over ssh'],
  ['open', 'open a file or url in the browser'],
  ['auth', 'show current authentication status'],
  ['update', 'check for updates and install them'],
  ['worktree', 'manage git worktrees for parallel sessions'],
  ['schedule', 'manage scheduled cron jobs'],
  ['history', 'browse session history'],
  ['export', 'export the conversation to a file'],
  ['output-style', 'set the output style for responses'],
  ['pr-comments', 'fetch GitHub pull request comments'],
  ['security-review', 'scan for security vulnerabilities'],
  ['sdd-global-read', 'read global spec-driven development docs', ['sgr']],
  ['sdd-archive', 'archive completed spec-driven tasks', ['sar']],
  ['sdd-plan', 'create a spec-driven development plan', ['sp']],
  ['sdd-review', 'run a spec-driven code review', ['sr']],
  ['sdd-implement', 'implement the current spec-driven plan', ['si']],
  ['sdd-verify', 'verify implementation against the spec', ['sv']],
  ['sdd-ship', 'ship the verified implementation', ['ss']],
  ['sdd-debug', 'debug a failing spec-driven task', ['sd']],
  ['sdd-status', 'show spec-driven workflow status', ['sst']],
  ['git-commit-helper', 'git commit helper with message generation'],
  ['test-runner', 'run the project test suite'],
]

/** usage 分数：模拟 getSkillUsageScore（决定 epsilon tie-break 行为） */
const COMMAND_USAGE = new Map<string, number>()
const usageVariant = Number(process.env.USAGE_VARIANT ?? 0)
COMMAND_RAW.forEach(([, name], i) => {
  // 确定性伪随机 0..20，sdd-global-read / commit / plugin 高频
  // USAGE_VARIANT>0 时换一组确定性分配，用于检验 epsilon 结论的稳健性
  const stride = 7 + usageVariant
  COMMAND_USAGE.set(name, ((i * stride + 3 + usageVariant) % 23) % 21)
})
COMMAND_USAGE.set('sdd-global-read', usageVariant === 2 ? 4 : 18)
COMMAND_USAGE.set('commit', usageVariant === 1 ? 1 : 20)
COMMAND_USAGE.set('plugin', usageVariant === 2 ? 19 : 12)

const COMMAND_ITEMS = COMMAND_RAW.map(([name, desc, aliases]) =>
  toCommandItem(name, desc, aliases),
)

const COMMAND_QUERY_THRESHOLD = 0.3

/** 消费点 2：unifiedSuggestions（5 键 2/3/1/1/3，threshold 0.6，limit 15） */
type UnifiedItem = {
  displayText: string
  name: string
  server: string
  description: string
  agentType: string
}

function mcpResource(
  server: string,
  uri: string,
  name: string,
  description: string,
): UnifiedItem {
  return {
    type: 'mcp_resource',
    displayText: `${server}:${uri}`,
    description,
    server,
    uri,
    name,
  } as unknown as UnifiedItem
}

function agent(agentType: string, whenToUse: string): UnifiedItem {
  return {
    type: 'agent',
    displayText: `${agentType} (agent)`,
    description: whenToUse,
    agentType,
  } as unknown as UnifiedItem
}

// ~30 条，混合 MCP resources 与 agents
const UNIFIED_ITEMS: UnifiedItem[] = [
  mcpResource(
    'github',
    'repos/xiaocongyu66/claude-code-hardened',
    'claude-code',
    'main repository',
  ),
  mcpResource(
    'github',
    'repos/xiaocongyu66/claude-code-hardened/issues',
    'issues',
    'issue tracker',
  ),
  mcpResource(
    'github',
    'repos/xiaocongyu66/claude-code-hardened/pulls',
    'pulls',
    'pull requests',
  ),
  mcpResource(
    'filesystem',
    'src/utils/suggestions',
    'suggestions dir',
    'suggestion utils directory',
  ),
  mcpResource('filesystem', 'src/hooks', 'hooks dir', 'hook source directory'),
  mcpResource(
    'filesystem',
    'src/components',
    'components dir',
    'UI component sources',
  ),
  mcpResource(
    'memory',
    'memory://CLAUDE.md',
    'CLAUDE.md',
    'project memory file',
  ),
  mcpResource(
    'memory',
    'memory://settings.json',
    'settings',
    'user settings memory',
  ),
  mcpResource(
    'playwright',
    'browser/screenshot',
    'screenshot',
    'browser capture tool',
  ),
  mcpResource(
    'playwright',
    'browser/navigate',
    'navigate',
    'browser navigation',
  ),
  mcpResource('sqlite', 'db/logs', 'logs table', 'session logs database'),
  mcpResource('sqlite', 'db/stats', 'stats table', 'usage statistics database'),
  mcpResource(
    'context7',
    'docs/fuse.js',
    'fuse.js docs',
    'fuse.js library documentation',
  ),
  mcpResource('context7', 'docs/bun', 'bun docs', 'bun runtime documentation'),
  mcpResource(
    'chrome-devtools',
    'performance/trace',
    'trace',
    'performance trace capture',
  ),
  agent('code-reviewer', 'review code changes for quality and security issues'),
  agent('general-purpose', 'general purpose research and multi-step tasks'),
  agent('output-style-setup', 'update the output style configuration'),
  agent('search-specialist', 'expert web search and information retrieval'),
  agent('api-documenter', 'generate API documentation from source code'),
  agent('sdd-planner', 'create spec-driven development plans'),
  agent('sdd-implementer', 'implement spec-driven plans step by step'),
  agent('sdd-verifier', 'verify implementation against the spec'),
  agent('test-engineer', 'write and run project test suites'),
  agent('debugger', 'diagnose and fix failing builds and tests'),
  agent('performance-optimizer', 'profile and optimize hot paths'),
  agent('refactor-expert', 'safe refactoring of large codebases'),
  agent('docs-writer', 'write and maintain project documentation'),
  agent('security-auditor', 'audit dependencies and code for vulnerabilities'),
  agent('memory-keeper', 'extract and maintain long term memories'),
]

const UNIFIED_QUERY_THRESHOLD = 0.6
const UNIFIED_LIMIT = 15

/** 消费点 3：LogSelector（单键 searchableText，threshold 0.3，ignoreLocation） */
const LOG_TEXTS: string[] = [
  'session: fix fuse threshold recalibration in commandSuggestions.ts — differential harness measured score inflation 0.027 to 0.62 after weight normalization change',
  'session: debug permission denied error when accessing /root/wt-fuse7/node_modules during bun install on android proot environment',
  'session: implement regen-lockfile workflow with gh workflow run regen-lockfile.yml and artifact backfill for bun.lock consistency',
  'session: investigate api key rotation for firstParty provider — ANTHROPIC_API_KEY expired mid-session, switched to OAuth token',
  'session: refactor LogSelector deep search to use ignoreLocation true with FUSE_THRESHOLD 0.3 for long session text search',
  'session: typecheck failure in unifiedSuggestions.ts — AgentDefinition type mismatch after builtin-tools package update',
  'session: write snapshot tests for top-3 ordering of unified suggestions to pin the new score scale',
  'session: plugin marketplace search returns no results for fuse threshold query — candidate set shrank after fuzzy upgrade',
  'session: git commit message convention enforcement via commitlint and husky lint-staged pre-commit hooks',
  'session: memory file extraction — extract_memories feature reads CLAUDE.md hierarchy and stores session learnings',
  'session: daemon mode supervisor crash loop — workerRegistry restart backoff exceeded, patched with exponential decay',
  'session: model provider priority fallback firstParty to bedrock vertex foundry — modelType parameter overrides default',
  'session: coverage report shows src/components/LogSelector.tsx at zero test coverage, added integration test',
  'session: build pipeline splits 17MB single file into 600 chunks to cut RSS from 966MB to 35MB on version check',
  'session: worktree management — EnterWorktree and ExitWorktree tools create parallel feature branches for agent teams',
  'session: error in build step post-build.ts — globalThis.Bun destructure patch failed for vendor ripgrep binary path',
  'session: lockfile dependency overrides audit — fuse.js 7.3.0 pinned in both dependencies and overrides sections',
  'session: test failure analysis — snapshot assertion expected sdd-global-read first but got sdd-archive, score diff crossed epsilon',
  'session: hook config reload — useScheduledTasks poller interval drift fixed with monotonic clock',
  'session: api streaming retry on 429 rate limit — exponential backoff with jitter, respects retry-after header',
]

// ─────────────────────────────────────────────────────────────────────
// 查询集
// ─────────────────────────────────────────────────────────────────────

const COMMAND_QUERIES = [
  'com',
  'sdd',
  'ini',
  'his',
  'plug',
  'mem',
  'age',
  'con',
  'git',
  'file',
  'read',
  'test',
  'rev',
  'stat',
  'mo',
  'doc',
  'sec',
  'wor',
  'sch',
  'ins',
  // 别名前缀
  'sg',
  'si',
  'sv',
  'ci',
  // description 词（低权重键，分数差异最大的场景）
  'github',
  'auth',
  'token',
  'market',
  'context',
  'cron',
  'spec',
  'vim',
  'ssh',
  'oauth',
]

const UNIFIED_QUERIES = [
  'age',
  'cod',
  'rev',
  'mcp',
  'src',
  'conf',
  'mem',
  'plug',
  'test',
  'file',
  'doc',
  'con',
  'sdd',
  'spec',
  'debug',
  'search',
  'trace',
  'browser',
  'github',
  'fuse',
]

const LOG_QUERIES = [
  'fuse threshold',
  'permission denied',
  'api key',
  'typecheck failure',
  'memory file',
  'git commit',
  'test failure',
  'hook config',
  'model provider',
  'plugin marketplace',
  'lockfile overrides',
  'worktree tools',
  'daemon crash',
  'coverage zero',
  'build chunks',
  'rate limit retry',
  'snapshot assertion',
  'regen lockfile workflow',
]

// ─────────────────────────────────────────────────────────────────────
// 分析工具
// ─────────────────────────────────────────────────────────────────────

function runSearch(
  Fuse: AnyFuse,
  items: unknown[],
  options: Record<string, unknown>,
  query: string,
  limit?: number,
  threshold?: number,
): Hit[] {
  // threshold 覆盖时重建 Fuse：threshold 同时控制 bitap 门与最终分过滤，
  // 这是"改配置里的 threshold"的真实模拟
  const opts = threshold === undefined ? options : { ...options, threshold }
  const fuse = new Fuse(items, opts)
  const results = fuse.search(query, limit ? { limit } : undefined)
  return results.map((r, i) => ({
    // Fuse 内部按 idx 排序同分条目；用 item 序号或 refIndex 定位
    id: idOf(r, i),
    score: r.score ?? 0,
  }))
}

let ITEM_ID_FIXTURES = new WeakMap<object, string>()

function idOf(
  r: { item: unknown; refIndex?: number },
  fallbackIdx: number,
): string {
  if (typeof r.refIndex === 'number') return String(r.refIndex)
  const item = r.item as Record<string, unknown> | string | undefined
  if (item && typeof item === 'object') {
    const cached = ITEM_ID_FIXTURES.get(item)
    if (cached) return cached
  }
  if (typeof item === 'string') return item
  return `#${fallbackIdx}`
}

function tagItems(items: unknown[]): void {
  ITEM_ID_FIXTURES = new WeakMap()
  items.forEach((it, i) => {
    if (it && typeof it === 'object') ITEM_ID_FIXTURES.set(it, String(i))
  })
}

/** 排序翻转对数：common 条目中，相对顺序在两序列中不同的 pair 数 */
function inversionCount(a: Hit[], b: Hit[]): number {
  const rankB = new Map<string, number>()
  b.forEach((h, i) => rankB.set(h.id, i))
  const commonB = a.filter(h => rankB.has(h.id)).map(h => rankB.get(h.id)!)
  let inversions = 0
  for (let i = 0; i < commonB.length; i++) {
    for (let j = i + 1; j < commonB.length; j++) {
      if (commonB[i] > commonB[j]) inversions++
    }
  }
  return inversions
}

function setDiff(
  baseline: Hit[],
  other: Hit[],
): { lost: string[]; gained: string[] } {
  const baseIds = new Set(baseline.map(h => h.id))
  const otherIds = new Set(other.map(h => h.id))
  return {
    lost: [...baseIds].filter(id => !otherIds.has(id)),
    gained: [...otherIds].filter(id => !baseIds.has(id)),
  }
}

// ─────────────────────────────────────────────────────────────────────
// 消费点配置
// ─────────────────────────────────────────────────────────────────────

type Probe = {
  name: string
  items: unknown[]
  options: Record<string, unknown>
  queries: string[]
  baselineThreshold: number
  limit?: number
  sweepFrom: number
  /** epsilon 扫描（custom sort comparator，仅 commands） */
  epsilonProbe?: {
    usageOf: (id: string) => number
    nameOf: (id: string) => string
    aliasesOf: (id: string) => string[]
  }
}

function buildProbes(): Probe[] {
  const commandOptions = {
    includeScore: true,
    threshold: COMMAND_QUERY_THRESHOLD,
    location: 0,
    distance: 100,
    keys: [
      { name: 'commandName', weight: 3 },
      { name: 'partKey', weight: 2 },
      { name: 'aliasKey', weight: 2 },
      { name: 'descriptionKey', weight: 0.5 },
    ],
  }
  const unifiedOptions = {
    includeScore: true,
    threshold: UNIFIED_QUERY_THRESHOLD,
    keys: [
      { name: 'displayText', weight: 2 },
      { name: 'name', weight: 3 },
      { name: 'server', weight: 1 },
      { name: 'description', weight: 1 },
      { name: 'agentType', weight: 3 },
    ],
  }
  const logOptions = {
    keys: ['searchableText'],
    threshold: 0.3,
    ignoreLocation: true,
    includeScore: true,
  }

  return [
    {
      name: 'commandSuggestions (threshold 0.3, 4 keys 3/2/2/0.5)',
      items: COMMAND_ITEMS,
      options: commandOptions,
      queries: COMMAND_QUERIES,
      baselineThreshold: COMMAND_QUERY_THRESHOLD,
      sweepFrom: 0.3,
      epsilonProbe: {
        usageOf: id =>
          COMMAND_USAGE.get(COMMAND_RAW[Number(id)]?.[0] ?? '') ?? 0,
        nameOf: id => COMMAND_RAW[Number(id)]?.[0] ?? `#${id}`,
        aliasesOf: id => COMMAND_RAW[Number(id)]?.[2] ?? [],
      },
    },
    {
      name: 'unifiedSuggestions (threshold 0.6, 5 keys 2/3/1/1/3, limit 15)',
      items: UNIFIED_ITEMS,
      options: unifiedOptions,
      queries: UNIFIED_QUERIES,
      baselineThreshold: UNIFIED_QUERY_THRESHOLD,
      sweepFrom: 0.6,
      limit: UNIFIED_LIMIT,
    },
    {
      name: 'LogSelector (threshold 0.3, single key, ignoreLocation)',
      items: LOG_TEXTS.map(text => ({ searchableText: text })),
      options: logOptions,
      queries: LOG_QUERIES,
      baselineThreshold: 0.3,
      sweepFrom: 0.3,
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────
// custom sort comparator（镜像 commandSuggestions.ts 的排序，含 epsilon）
// ─────────────────────────────────────────────────────────────────────

type Sortable = {
  id: string
  score: number
  usage: number
  name: string
  aliases: string[]
}

/** 判定一对同查结果在 custom comparator 中是否会走到 score/usage 阶段 */
function reachesScoreStage(a: Sortable, b: Sortable, query: string): boolean {
  const q = query.toLowerCase()
  const an = a.name.toLowerCase()
  const bn = b.name.toLowerCase()
  const aa = a.aliases.map(x => x.toLowerCase())
  const ba = b.aliases.map(x => x.toLowerCase())
  const aExactName = an === q
  const bExactName = bn === q
  if (aExactName !== bExactName) return false
  const aExactAlias = aa.includes(q)
  const bExactAlias = ba.includes(q)
  if (aExactAlias !== bExactAlias) return false
  const aPrefixName = an.startsWith(q)
  const bPrefixName = bn.startsWith(q)
  if (aPrefixName !== bPrefixName) return false
  if (aPrefixName && bPrefixName && an.length !== bn.length) return false
  const aPrefixAlias = aa.find(x => x.startsWith(q))
  const bPrefixAlias = ba.find(x => x.startsWith(q))
  if ((aPrefixAlias !== undefined) !== (bPrefixAlias !== undefined))
    return false
  if (
    aPrefixAlias &&
    bPrefixAlias &&
    aPrefixAlias.length !== bPrefixAlias.length
  ) {
    return false
  }
  return true
}

function repoSort(
  rows: Sortable[],
  query: string,
  epsilon: number,
): Sortable[] {
  const q = query.toLowerCase()
  return [...rows].sort((a, b) => {
    const aName = a.name.toLowerCase()
    const bName = b.name.toLowerCase()
    const aAliases = a.aliases.map(x => x.toLowerCase())
    const bAliases = b.aliases.map(x => x.toLowerCase())

    const aExactName = aName === q
    const bExactName = bName === q
    if (aExactName && !bExactName) return -1
    if (bExactName && !aExactName) return 1

    const aExactAlias = aAliases.includes(q)
    const bExactAlias = bAliases.includes(q)
    if (aExactAlias && !bExactAlias) return -1
    if (bExactAlias && !aExactAlias) return 1

    const aPrefixName = aName.startsWith(q)
    const bPrefixName = bName.startsWith(q)
    if (aPrefixName && !bPrefixName) return -1
    if (bPrefixName && !aPrefixName) return 1
    if (aPrefixName && bPrefixName && aName.length !== bName.length) {
      return aName.length - bName.length
    }

    const aPrefixAlias = aAliases.find(alias => alias.startsWith(q))
    const bPrefixAlias = bAliases.find(alias => alias.startsWith(q))
    if (aPrefixAlias && !bPrefixAlias) return -1
    if (bPrefixAlias && !aPrefixAlias) return 1
    if (
      aPrefixAlias &&
      bPrefixAlias &&
      aPrefixAlias.length !== bPrefixAlias.length
    ) {
      return aPrefixAlias.length - bPrefixAlias.length
    }

    const scoreDiff = a.score - b.score
    if (Math.abs(scoreDiff) > epsilon) return scoreDiff
    return b.usage - a.usage
  })
}

// ─────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────

async function loadFuse(dir: string): Promise<AnyFuse> {
  const esmPath = `${dir}/package/dist/fuse.mjs`
  try {
    const mod = (await import(esmPath)) as { default: AnyFuse }
    if (mod?.default) return mod.default
  } catch {
    // fallback to CJS below
  }
  const { createRequire } = await import('module')
  const require = createRequire(import.meta.url)
  return require(`${dir}/package/dist/fuse.cjs`) as AnyFuse
}

async function main(): Promise<void> {
  const v73 = await loadFuse(FUSE73_DIR)
  const v75 = await loadFuse(FUSE75_DIR)
  console.log('='.repeat(78))
  console.log('fuse.js 7.3.0 vs 7.5.0 差分对拍')
  console.log('='.repeat(78))

  for (const probe of buildProbes()) {
    tagItems(probe.items)
    console.log(`\n${'─'.repeat(78)}\n[${probe.name}]\n${'─'.repeat(78)}`)

    // 分数标度采样（同阈值下 7.3/7.5 对同一批命中给出什么分数）
    let scoreSum73 = 0
    let scoreSum75 = 0
    let scorePairs = 0
    let diffSum73 = 0
    let diffSum75 = 0
    let diffPairs = 0

    const sweep: Array<{
      t: number
      top1: number
      overlap: number
      inv: number
      gained: number
    }> = []
    const sweepValues: number[] = []
    for (
      let t = probe.sweepFrom;
      t <= 0.95 + 1e-9;
      t = Math.round((t + 0.05) * 100) / 100
    ) {
      sweepValues.push(t)
    }

    const baselineByQuery = new Map<string, Hit[]>()
    const at75ByQuery = new Map<string, Hit[]>()

    for (const query of probe.queries) {
      // 注意：Fuse.search 不按 combined score 过滤（threshold 只作
      // bitap 门），这里不做任何 post-filter，保持与消费点一致
      const base = runSearch(
        v73,
        probe.items,
        probe.options,
        query,
        probe.limit,
      )
      const at75 = runSearch(
        v75,
        probe.items,
        probe.options,
        query,
        probe.limit,
      )
      baselineByQuery.set(query, base)
      at75ByQuery.set(query, at75)

      for (const h of base) {
        const twin = at75.find(x => x.id === h.id)
        if (twin) {
          scoreSum73 += h.score
          scoreSum75 += twin.score
          scorePairs++
        }
      }
      // 相邻 pair 分差膨胀采样
      for (let i = 1; i < base.length; i++) {
        const d73 = base[i].score - base[i - 1].score
        const t75 = at75.find(x => x.id === base[i].id)
        const t75prev = at75.find(x => x.id === base[i - 1].id)
        if (t75 && t75prev) {
          diffSum73 += Math.abs(d73)
          diffSum75 += Math.abs(t75.score - t75prev.score)
          diffPairs++
        }
      }
    }

    // ①②③ 旧阈值下的差异汇总
    let top1Agree = 0
    let queriesWithHits = 0
    let totalLost = 0
    let totalGained = 0
    let totalInv = 0
    const shrinkExamples: string[] = []
    for (const query of probe.queries) {
      const base = baselineByQuery.get(query)!
      const at75 = at75ByQuery.get(query)!
      if (base.length > 0) queriesWithHits++
      if (base.length > 0 && at75.length > 0) {
        if (base[0].id === at75[0].id) top1Agree++
      }
      const { lost, gained } = setDiff(base, at75)
      totalLost += lost.length
      totalGained += gained.length
      totalInv += inversionCount(base, at75)
      if (lost.length > 0 && shrinkExamples.length < 5) {
        shrinkExamples.push(
          `  '${query}': 丢 ${lost.length} 个 [${lost.slice(0, 4).join(',')}] (73命中 ${base.length} → 75命中 ${at75.length})`,
        )
      }
    }

    console.log(
      `查询数 ${probe.queries.length}，其中有基线命中的 ${queriesWithHits}`,
    )
    if (scorePairs > 0) {
      console.log(
        `分数标度：共同命中 ${scorePairs} 条，平均分 7.3=${(scoreSum73 / scorePairs).toFixed(4)} → 7.5=${(scoreSum75 / scorePairs).toFixed(4)}（膨胀 ${(scoreSum75 / Math.max(scoreSum73, 1e-9)).toFixed(1)}x）`,
      )
    }
    if (diffPairs > 0) {
      console.log(
        `相邻分差：平均 |Δ| 7.3=${(diffSum73 / diffPairs).toFixed(4)} → 7.5=${(diffSum75 / diffPairs).toFixed(4)}（膨胀 ${(diffSum75 / Math.max(diffSum73, 1e-9)).toFixed(1)}x）`,
      )
    }
    console.log(
      `旧阈值 ${probe.baselineThreshold} 下：top-1 一致 ${top1Agree}/${queriesWithHits}；命中集丢失 ${totalLost} / 新增 ${totalGained}；排序翻转对 ${totalInv}`,
    )
    for (const line of shrinkExamples) console.log(line)

    // ④ 阈值扫描：7.5 下哪个 threshold 最贴近 7.3 基线
    // 注意：threshold 改动会同时移动 bitap 门（候选池）与最终分过滤，
    // 因此这里必须以 threshold=t 重建 Fuse 做真实模拟
    for (const t of sweepValues) {
      let top1 = 0
      let overlapSum = 0
      let overlapN = 0
      let inv = 0
      let gained = 0
      for (const query of probe.queries) {
        const base = baselineByQuery.get(query)!
        const at = runSearch(
          v75,
          probe.items,
          probe.options,
          query,
          probe.limit,
          t,
        )
        if (base.length > 0 && at.length > 0 && base[0].id === at[0].id) top1++
        const baseIds = new Set(base.map(h => h.id))
        const atIds = new Set(at.map(h => h.id))
        const union = new Set([...baseIds, ...atIds]).size
        if (union > 0) {
          let inter = 0
          for (const id of baseIds) if (atIds.has(id)) inter++
          overlapSum += inter / union
          overlapN++
        }
        inv += inversionCount(base, at)
        gained += [...atIds].filter(id => !baseIds.has(id)).length
      }
      sweep.push({
        t,
        top1,
        overlap: overlapN > 0 ? overlapSum / overlapN : 1,
        inv,
        gained,
      })
    }

    console.log(
      '\n阈值扫描（7.5 以 threshold=t 重建索引 → top-1一致, Jaccard 平均, 翻转对, 新增[7.3拒绝的]) :',
    )
    for (const row of sweep) {
      const marker =
        row.top1 === top1AgreeMax(sweep) && row.overlap === maxOverlap(sweep)
          ? ' ◀'
          : ''
      console.log(
        `  t=${row.t.toFixed(2)}  top1=${row.top1}/${queriesWithHits}  Jaccard=${row.overlap.toFixed(3)}  翻转=${row.inv}  新增=${row.gained}${marker}`,
      )
    }

    // 选优：top-1 一致优先 → 命中集覆盖不缩其次 → 翻转率最低 → 新增（误纳）最少
    const best = [...sweep].sort((a, b) => {
      if (a.top1 !== b.top1) return b.top1 - a.top1
      if (Math.abs(a.overlap - b.overlap) > 1e-9) return b.overlap - a.overlap
      if (a.inv !== b.inv) return a.inv - b.inv
      return a.gained - b.gained
    })[0]
    console.log(
      `▶ 建议 threshold：${probe.baselineThreshold} → ${best.t.toFixed(2)}（top1 ${best.top1}/${queriesWithHits}, Jaccard ${best.overlap.toFixed(3)}, 翻转 ${best.inv}, 新增 ${best.gained}）`,
    )

    // ⑤ epsilon 扫描（custom sort 决策最贴近 7.3 基线）
    // 用 7.3@基线阈值 全结果 vs 7.5@建议阈值 全结果，比较 repoSort 的最终顺序
    if (probe.epsilonProbe) {
      const bestT = best.t
      // score 阶段管辖的 pair 群体：7.5 下 |Δ| 分布
      const sameTypeDiffs: number[] = []
      for (const query of probe.queries) {
        const at75 = runSearch(
          v75,
          probe.items,
          probe.options,
          query,
          probe.limit,
          bestT,
        )
        const rows = at75.map(h => ({
          id: h.id,
          score: h.score,
          usage: probe.epsilonProbe!.usageOf(h.id),
          name: probe.epsilonProbe!.nameOf(h.id),
          aliases: probe.epsilonProbe!.aliasesOf(h.id),
        }))
        for (let i = 0; i < rows.length; i++) {
          for (let j = i + 1; j < rows.length; j++) {
            if (reachesScoreStage(rows[i], rows[j], query)) {
              sameTypeDiffs.push(Math.abs(rows[i].score - rows[j].score))
            }
          }
        }
      }
      if (sameTypeDiffs.length > 0) {
        sameTypeDiffs.sort((a, b) => a - b)
        const pct = (p: number) =>
          sameTypeDiffs[
            Math.min(
              sameTypeDiffs.length - 1,
              Math.floor(p * sameTypeDiffs.length),
            )
          ]
        console.log(
          `\nscore 阶段 pair 群体（7.5@${bestT.toFixed(2)}，n=${sameTypeDiffs.length}）：|Δ| p50=${pct(0.5).toFixed(3)} p75=${pct(0.75).toFixed(3)} p90=${pct(0.9).toFixed(3)} p95=${pct(0.95).toFixed(3)} max=${sameTypeDiffs[sameTypeDiffs.length - 1].toFixed(3)}`,
        )
      }
      const epsValues: number[] = []
      for (
        let e = 0.1;
        e <= 0.4 + 1e-9;
        e = Math.round((e + 0.01) * 100) / 100
      ) {
        epsValues.push(e)
      }
      const epsRows: Array<{ e: number; inv: number; flip: number }> = []
      for (const e of epsValues) {
        let inv = 0
        let flip = 0
        for (const query of probe.queries) {
          const base = baselineByQuery.get(query)!
          const at75 = runSearch(
            v75,
            probe.items,
            probe.options,
            query,
            probe.limit,
            bestT,
          )
          const toRows = (hits: Hit[]): Sortable[] =>
            hits.map(h => ({
              id: h.id,
              score: h.score,
              usage: probe.epsilonProbe!.usageOf(h.id),
              name: probe.epsilonProbe!.nameOf(h.id),
              aliases: probe.epsilonProbe!.aliasesOf(h.id),
            }))
          const baseRows = toRows(base)
          if (baseRows.length < 2 && at75.length < 2) continue
          const baseOrder = repoSort(baseRows, query, 0.1).map(r => r.id)
          const order75 = repoSort(toRows(at75), query, e).map(r => r.id)
          inv += inversionCount(
            baseOrder.map(id => ({ id, score: 0 })),
            order75.map(id => ({ id, score: 0 })),
          )
          for (let i = 0; i < Math.min(baseOrder.length, order75.length); i++) {
            if (baseOrder[i] !== order75[i]) flip++
          }
        }
        epsRows.push({ e, inv, flip })
      }
      console.log(
        `\nepsilon 扫描（7.3@${probe.baselineThreshold},eps=0.1 vs 7.5@${bestT.toFixed(2)},eps=e 的 custom-sort 顺序）:`,
      )
      for (const row of epsRows) {
        console.log(
          `  eps=${row.e.toFixed(2)}  翻转对=${row.inv}  位置失配=${row.flip}`,
        )
      }
      const bestEps = [...epsRows].sort(
        (a, b) => a.inv - b.inv || a.flip - b.flip,
      )[0]
      console.log(
        `▶ 建议 epsilon：0.1 → ${bestEps.e.toFixed(2)}（翻转对 ${bestEps.inv}, 位置失配 ${bestEps.flip}）`,
      )
      // 翻转细节：剩余顺序差异来自哪些 pair
      for (const query of probe.queries) {
        const base = baselineByQuery.get(query)!
        const at75 = runSearch(
          v75,
          probe.items,
          probe.options,
          query,
          probe.limit,
          bestT,
        )
        const toRows = (hits: Hit[]): Sortable[] =>
          hits.map(h => ({
            id: h.id,
            score: h.score,
            usage: probe.epsilonProbe!.usageOf(h.id),
            name: probe.epsilonProbe!.nameOf(h.id),
            aliases: probe.epsilonProbe!.aliasesOf(h.id),
          }))
        const baseRows = toRows(base)
        if (baseRows.length < 2) continue
        const baseOrder = repoSort(baseRows, query, 0.1).map(r => r.id)
        const order75 = repoSort(toRows(at75), query, bestEps.e).map(r => r.id)
        const common = baseOrder.filter(id => order75.includes(id))
        const pos75 = new Map(order75.map((id, i) => [id, i]))
        let moved = false
        for (let i = 0; i < common.length; i++) {
          for (let j = i + 1; j < common.length; j++) {
            if (pos75.get(common[i])! > pos75.get(common[j])!) {
              const ra = toRows(at75).find(r => r.id === common[i])!
              const rb = toRows(at75).find(r => r.id === common[j])!
              console.log(
                `    [${query}] '${ra.name}'(s=${ra.score.toFixed(4)},u${ra.usage}) 与 '${rb.name}'(s=${rb.score.toFixed(4)},u${rb.usage}) 顺序翻转（|Δ|=${Math.abs(ra.score - rb.score).toFixed(4)}）`,
              )
              moved = true
            }
          }
        }
        if (moved) void 0
      }
    }
  }

  console.log(`\n${'='.repeat(78)}\n对拍完成`)
}

function top1AgreeMax(rows: Array<{ top1: number }>): number {
  return Math.max(...rows.map(r => r.top1))
}
function maxOverlap(rows: Array<{ overlap: number }>): number {
  return Math.max(...rows.map(r => r.overlap))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
