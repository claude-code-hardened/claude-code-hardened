#!/usr/bin/env bun
/**
 * memory-replay — offline long-session memory replayer (Phase 0 diagnostics).
 *
 * Drives the REAL query pipeline (src/query.ts) with no network: a scripted
 * `deps.callModel` fake (QueryDeps injection seam, src/query/deps.ts) feeds
 * the loop, real tool orchestration executes in-memory Replay* fake tools,
 * and a synthetic transcript (short turns / fat tool_use+tool_result pairs /
 * patch-style file edits / simulated /compact boundaries) grows across rounds
 * exactly like a REPL mutableMessages array.
 *
 * Why: Bun/mimalloc does not return freed pages to the OS after GC (measured,
 * see src/utils/sessionStorage.ts ~:4004 — "arrayBuffers=0 after Bun.gc(true)
 * but RSS stuck at ~316MB"). Long-session RSS 400MB→4GB tells us nothing
 * until we separate:
 *   1. JS live-heap growth  (survives Bun.gc(true) — post-GC heapUsed slope)
 *   2. allocator retention  (RSS stays high while post-GC heap does not)
 *
 * Usage (run from the repo root so `src/*` tsconfig aliases resolve):
 *   bun scripts/memory-replay.ts --messages 10000 --out /tmp/memrun
 *        [--seed 42] [--heapdump N] [--gc-every K] [--compact-every N]
 *        [--compact-keep M] [--payload-min-kb 100] [--payload-max-kb 2048]
 *        [--ratio short:toolPair:edit] [--max-turns 6] [--profile]
 *
 * Outputs (in --out):
 *   samples.jsonl             per-round + per-GC-probe memory samples
 *   snapshot-*-*.heapsnapshot with --heapdump N (start / every N rounds / end)
 *   summary.json              machine-readable attribution table
 *
 * This is a measurement harness: pipeline errors fail loudly (non-zero)
 * instead of being swallowed.
 */

import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import {
  buildPayload,
  createReplaySynthesizer,
  type ReplayRoundKind,
  type ReplayRoundPlan,
  type ReplaySynthConfig,
  type ReplaySynthesizer,
} from './lib/replaySynth.ts'
import {
  compareSnapshotFiles,
  DEFAULT_FOCUS_KEYWORDS,
  formatBytes,
} from './heapdiff.ts'

// Type-only imports: erased at runtime, so no src module graph is loaded
// before main() has prepared the environment (env vars + MACRO shim).
import type { QueryDeps } from '../src/query/deps.ts'
import type { QueryParams } from '../src/query.ts'
import type { AssistantMessage, Message } from '../src/types/message.ts'
import type { Tool, ToolResultBlockParam, ToolUseContext } from '../src/Tool.ts'
import type { FileAttributionState } from '../src/types/logs.ts'
import type { AttributionState } from '../src/utils/commitAttribution.ts'
import type { ReactNode } from 'react'

// ─── Constants ───────────────────────────────────────────────────────────

export const REPLAY_READ_TOOL = 'ReplayRead'
export const REPLAY_EDIT_TOOL = 'ReplayEdit'
export const SAMPLE_FILE = 'samples.jsonl'
export const SUMMARY_FILE = 'summary.json'
const KB = 1024

// ─── CLI ─────────────────────────────────────────────────────────────────

export type ReplayCliOptions = {
  messages: number
  out: string
  seed: number
  heapdumpEvery: number
  gcEvery: number
  compactEvery: number
  compactKeep: number
  payloadMinBytes: number
  payloadMaxBytes: number
  ratios: { short: number; toolPair: number; edit: number }
  maxTurns: number
  profile: boolean
}

export function parseCliOptions(argv: string[]): ReplayCliOptions | null {
  const o: ReplayCliOptions = {
    messages: 10_000,
    out: '/tmp/memrun',
    seed: 42,
    heapdumpEvery: 0,
    gcEvery: 25,
    compactEvery: 50,
    compactKeep: 40,
    payloadMinBytes: 100 * KB,
    payloadMaxBytes: 2048 * KB,
    ratios: { short: 6, toolPair: 3, edit: 1 },
    maxTurns: 6,
    profile: false,
  }
  const nextNum = (fallback: number): number => {
    const raw = argv[i + 1]
    if (raw === undefined) return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
  let i = 0
  let messages: number | null = null
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === undefined) break
    switch (arg) {
      case '--messages':
        messages = nextNum(o.messages)
        i += 1
        break
      case '--out':
        o.out = argv[i + 1] ?? o.out
        i += 1
        break
      case '--seed':
        o.seed = nextNum(o.seed)
        i += 1
        break
      case '--heapdump':
        o.heapdumpEvery = Math.floor(nextNum(o.heapdumpEvery))
        i += 1
        break
      case '--gc-every':
        o.gcEvery = Math.floor(nextNum(o.gcEvery))
        i += 1
        break
      case '--compact-every':
        o.compactEvery = Math.floor(nextNum(o.compactEvery))
        i += 1
        break
      case '--compact-keep':
        o.compactKeep = Math.floor(nextNum(o.compactKeep))
        i += 1
        break
      case '--payload-min-kb':
        o.payloadMinBytes = nextNum(o.payloadMinBytes / KB) * KB
        i += 1
        break
      case '--payload-max-kb':
        o.payloadMaxBytes = nextNum(o.payloadMaxBytes / KB) * KB
        i += 1
        break
      case '--ratio': {
        const raw = argv[i + 1]
        if (!raw) return null
        const parts = raw.split(':').map(s => Number(s.trim()))
        if (parts.length !== 3 || parts.some(p => !Number.isFinite(p))) {
          return null
        }
        o.ratios = { short: parts[0]!, toolPair: parts[1]!, edit: parts[2]! }
        i += 1
        break
      }
      case '--max-turns':
        o.maxTurns = Math.floor(nextNum(o.maxTurns))
        i += 1
        break
      case '--help':
      case '-h':
        return null
      case '--profile':
        o.profile = true
        break
      default:
        if (arg.startsWith('--')) return null
        return null
    }
    i += 1
  }
  if (messages !== null) o.messages = messages
  if (!Number.isFinite(o.messages) || o.messages < 1) return null
  if (o.payloadMaxBytes < o.payloadMinBytes) return null
  if (o.maxTurns < 1) return null
  return o
}

export function usage(): string {
  return [
    'Usage: bun scripts/memory-replay.ts --messages 10000 --out /tmp/memrun',
    '       [--seed 42] [--heapdump N] [--gc-every K] [--compact-every N]',
    '       [--compact-keep M] [--payload-min-kb 100] [--payload-max-kb 2048]',
    '       [--ratio short:toolPair:edit] [--max-turns 6] [--profile]',
  ].join('\n')
}

// ─── Cheap hrtime clock (profilerBase-style; perf_hooks is forbidden) ────

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000
}

// ─── Memory helpers ──────────────────────────────────────────────────────

export type MemSample = {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
  arrayBuffers: number
}

function sampleMemory(): MemSample {
  const m = process.memoryUsage()
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  }
}

function fullGc(): void {
  if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') {
    Bun.gc(true)
  }
}

function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function padStart(value: string, width: number): string {
  return value.length >= width
    ? value
    : ' '.repeat(width - value.length) + value
}

function padEnd(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + ' '.repeat(width - value.length)
}

/** Ordinary-least-squares slope of value over seconds (bytes/sec). */
export function olsSlope(points: Array<[number, number]>): number {
  const n = points.length
  if (n < 2) return 0
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumX2 = 0
  for (const [x, y] of points) {
    sumX += x
    sumY += y
    sumXY += x * y
    sumX2 += x * x
  }
  const denom = n * sumX2 - sumX * sumX
  if (denom === 0) return 0
  return (n * sumXY - sumX * sumY) / denom
}

// ─── Heap snapshot writer (mirrors src/utils/heapDumpService.ts Bun path) ─

function writeHeapSnapshot(path: string): void {
  // Bun.generateHeapSnapshot('v8', 'arraybuffer') — non-streaming variant;
  // the 2-arg overload is ahead of bun-types (same @ts-expect-error situation
  // as heapDumpService.ts), so reach it through a typed private surface
  // instead of `any`.
  const gen = (
    Bun as unknown as {
      generateHeapSnapshot: (
        format: 'v8',
        encoding: 'arraybuffer',
      ) => ArrayBuffer
    }
  ).generateHeapSnapshot
  // Buffer view over the ArrayBuffer — zero-copy handoff to the sync write.
  writeFileSync(path, Buffer.from(gen('v8', 'arraybuffer')))
}

// ─── Attribution bookkeeping (mirrors REPL-level attribution fattening) ──

export type AttributionStore = { state: AttributionState }

export function emptyAttributionState(): AttributionState {
  return {
    fileStates: new Map<string, FileAttributionState>(),
    sessionBaselines: new Map<string, { contentHash: string; mtime: number }>(),
    surface: 'replay',
    startingHeadSha: null,
    promptCount: 0,
    promptCountAtLastCommit: 0,
    permissionPromptCount: 0,
    permissionPromptCountAtLastCommit: 0,
    escapeCount: 0,
    escapeCountAtLastCommit: 0,
  }
}

/** Cheap rolling content hash (FNV-1a) for virtual file states. */
export function fnv1aHex(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ─── src module bootstrap ────────────────────────────────────────────────

type SrcModules = {
  query: typeof import('../src/query.ts').query
  createUserMessage: typeof import('../src/utils/messages.ts').createUserMessage
  createCompactBoundaryMessage: typeof import('../src/utils/messages.ts').createCompactBoundaryMessage
  asSystemPrompt: typeof import('../src/utils/systemPromptType.ts').asSystemPrompt
  buildTool: typeof import('../src/Tool.ts').buildTool
  resetStateForTests: typeof import('../src/bootstrap/state.ts').resetStateForTests
  setOriginalCwd: typeof import('../src/bootstrap/state.ts').setOriginalCwd
  setCwdState: typeof import('../src/bootstrap/state.ts').setCwdState
  setProjectRoot: typeof import('../src/bootstrap/state.ts').setProjectRoot
  setSessionPersistenceDisabled: typeof import('../src/bootstrap/state.ts').setSessionPersistenceDisabled
}

async function loadSrcModules(): Promise<SrcModules> {
  const [queryMod, messagesMod, sysPromptMod, toolMod, stateMod] =
    await Promise.all([
      import('../src/query.ts'),
      import('../src/utils/messages.ts'),
      import('../src/utils/systemPromptType.ts'),
      import('../src/Tool.ts'),
      import('../src/bootstrap/state.ts'),
    ])
  return {
    query: queryMod.query,
    createUserMessage: messagesMod.createUserMessage,
    createCompactBoundaryMessage: messagesMod.createCompactBoundaryMessage,
    asSystemPrompt: sysPromptMod.asSystemPrompt,
    buildTool: toolMod.buildTool,
    resetStateForTests: stateMod.resetStateForTests,
    setOriginalCwd: stateMod.setOriginalCwd,
    setCwdState: stateMod.setCwdState,
    setProjectRoot: stateMod.setProjectRoot,
    setSessionPersistenceDisabled: stateMod.setSessionPersistenceDisabled,
  }
}

/**
 * Runtime MACRO fallback. cli.tsx normally installs this for CLI runs; a
 * directly-run script must not depend on the CLI entrypoint. Values mirror
 * the shim in src/entrypoints/cli.tsx.
 */
function installMacroShim(): void {
  const g = globalThis as unknown as { MACRO?: Record<string, string> }
  if (g.MACRO === undefined) {
    g.MACRO = {
      VERSION: process.env.CLAUDE_CODE_VERSION || '2.1.888',
      BUILD_TIME: new Date().toISOString(),
      FEEDBACK_CHANNEL: '',
      ISSUES_EXPLAINER: '',
      NATIVE_PACKAGE_URL: '',
      PACKAGE_URL: '',
      VERSION_CHANGELOG: '',
    }
  }
}

function setupReplayEnvironment(configDir: string): void {
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CI = 'true'
  process.env.GITHUB_ACTIONS = 'true'
  // Must be 'test': src/bootstrap/state.ts resetStateForTests() (called below)
  // THROWS outside a test environment. 'development' would abort the run.
  process.env.NODE_ENV = 'test'
  process.env.NO_COLOR = '1'
  process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
  process.env.DISABLE_COMPACT = '1'
}

// ─── Scripted model calls (the deps.callModel fake) ──────────────────────

type RoundContext = {
  round: ReplayRoundPlan | null
  callIndexInRound: number
  approxInputTokens: number
}

function makeAssistantMessage(
  round: ReplayRoundPlan,
  callIndex: number,
  seed: number,
  stopReason: 'end_turn' | 'tool_use',
  content: Array<Record<string, unknown>>,
  inputTokens: number,
  outputTokens: number,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `replay-assistant-${seed}-${round.index}-${callIndex}`,
    timestamp: new Date().toISOString(),
    requestId: undefined,
    message: {
      id: `msg_replay_${seed}_${round.index}_${callIndex}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content,
    },
  } as unknown as AssistantMessage
}

function buildScriptedDeps(
  roundContext: RoundContext,
  seed: number,
  toolUseIdOut: { current: string },
): QueryDeps {
  let uuidCounter = 0

  async function* fakeCallModel(
    _input: Parameters<QueryDeps['callModel']>[0],
  ): AsyncGenerator<AssistantMessage, void, unknown> {
    const round = roundContext.round
    if (!round) return
    const callIndex = roundContext.callIndexInRound
    roundContext.callIndexInRound += 1

    const isFollowUp = callIndex > 0
    const toolUseId = `toolu_replay_${seed}_${round.index}_${callIndex}`
    toolUseIdOut.current = toolUseId
    const outputTokens = round.kind === 'short' ? 64 : 256

    if (isFollowUp || round.kind === 'short') {
      yield makeAssistantMessage(
        round,
        callIndex,
        seed,
        'end_turn',
        [
          {
            type: 'text',
            text: `Replay turn ${round.index} complete (${round.kind}, call ${callIndex}).`,
          },
        ],
        roundContext.approxInputTokens,
        outputTokens,
      )
      return
    }

    const toolBlock: Record<string, unknown> =
      round.kind === 'tool_pair'
        ? {
            type: 'tool_use',
            id: toolUseId,
            name: REPLAY_READ_TOOL,
            input: { file_path: round.file, bytes: round.payloadSize ?? 0 },
          }
        : {
            type: 'tool_use',
            id: toolUseId,
            name: REPLAY_EDIT_TOOL,
            input: {
              file_path: round.file,
              old_string: round.oldString ?? '',
              new_string: round.newString ?? '',
            },
          }
    yield makeAssistantMessage(
      round,
      callIndex,
      seed,
      'tool_use',
      [
        {
          type: 'text',
          text: `Replay turn ${round.index}: working via ${toolBlock.name}.`,
        },
        toolBlock,
      ],
      roundContext.approxInputTokens,
      outputTokens,
    )
  }

  const fakeDeps = {
    uuid: (): string => `replay-chain-${seed}-${(uuidCounter += 1)}`,
    microcompact: async (
      messages: Message[],
    ): Promise<{ messages: Message[] }> => ({ messages }),
    autocompact: async (): Promise<{
      wasCompacted: boolean
      consecutiveFailures: number
    }> => ({ wasCompacted: false, consecutiveFailures: 0 }),
    callModel: fakeCallModel,
  }
  return fakeDeps as unknown as QueryDeps
}

// ─── Replay fake tools (real orchestration path, in-memory payloads) ─────

function buildReplayTools(
  buildTool: SrcModules['buildTool'],
  roundContext: RoundContext,
  synth: ReplaySynthesizer,
): Tool[] {
  const readTool = buildTool({
    name: REPLAY_READ_TOOL,
    description:
      'Replay-only tool returning a deterministic payload of the requested size.',
    inputSchema: z.object({ file_path: z.string(), bytes: z.number() }),
    // Never persist: the whole point is fat in-memory tool results.
    maxResultSizeChars: Number.MAX_SAFE_INTEGER,
    call: async args => {
      const payload = buildPayload(
        `${args.file_path}#${args.bytes}`,
        args.bytes,
      )
      return { data: payload }
    },
    prompt: async () =>
      'Returns a synthetic payload sized in bytes. Replay fixture tool only.',
    renderToolUseMessage: (input): ReactNode =>
      `Read ${input.file_path ?? '?'} (${input.bytes ?? '?'}B)`,
    mapToolResultToToolResultBlockParam: (
      content: string,
      toolUseID: string,
    ): ToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: toolUseID,
      content,
    }),
    userFacingName: () => REPLAY_READ_TOOL,
  })

  const editTool = buildTool({
    name: REPLAY_EDIT_TOOL,
    description: 'Replay-only patch-style file edit against a virtual file.',
    inputSchema: z.object({
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
    }),
    maxResultSizeChars: Number.MAX_SAFE_INTEGER,
    call: async (args, context) => {
      const round = roundContext.round
      const before = synth.virtualFileAfter(
        (round?.index ?? 1) - 1,
        args.file_path,
      )
      const updatedFile = before.includes(args.old_string)
        ? before.replace(args.old_string, args.new_string)
        : `${before}\n${args.new_string}`

      // Same flow REPL attribution runs through: updateAttributionState with
      // a per-file FileAttributionState updater (contentHash + contribution).
      context.updateAttributionState(prev => {
        const existing = prev.fileStates.get(args.file_path)
        const next: FileAttributionState = {
          contentHash: fnv1aHex(updatedFile),
          claudeContribution:
            (existing?.claudeContribution ?? 0) + args.new_string.length,
          mtime: nowMs(),
        }
        return {
          ...prev,
          fileStates: new Map(prev.fileStates).set(args.file_path, next),
        }
      })

      const structuredPatch = [
        {
          oldStart: 1,
          oldLines: args.old_string.split('\n').length,
          newStart: 1,
          newLines: args.new_string.split('\n').length,
          lines: [`-${args.old_string}`, `+${args.new_string}`],
        },
      ]
      return {
        data: {
          type: 'text',
          filePath: args.file_path,
          originalFile: before,
          updatedFile,
          structuredPatch,
        },
      }
    },
    prompt: async () =>
      'Applies a synthetic patch to a virtual file. Replay fixture tool only.',
    renderToolUseMessage: (input): ReactNode =>
      `Edit ${input.file_path ?? '?'}`,
    mapToolResultToToolResultBlockParam: (
      content: {
        filePath: string
        updatedFile: string
        structuredPatch: Array<Record<string, unknown>>
      },
      toolUseID: string,
    ): ToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: `Applied patch to ${content.filePath}`,
    }),
    userFacingName: () => REPLAY_EDIT_TOOL,
  })

  return [readTool, editTool]
}

// ─── ToolUseContext (mirrors the proven offline boundary-test shim) ──────

type ToolUseContextOptions = {
  tools: Tool[]
  attribution: AttributionStore
}

function buildToolUseContext(options: ToolUseContextOptions): ToolUseContext {
  let appState = {
    toolPermissionContext: { mode: 'default' },
    fastMode: false,
    mcp: { tools: [] as Tool[], clients: [] as unknown[] },
    effortValue: undefined,
    advisorModel: undefined,
    sessionHooks: new Map<string, unknown>(),
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-5-20250929',
      tools: options.tools,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (updater: (prev: typeof appState) => typeof appState) => {
      appState = updater(appState)
    },
    setInProgressToolUseIDs: (
      updater: (prev: Set<string>) => Set<string>,
    ): Set<string> => updater(new Set<string>()),
    setResponseLength: (updater: (prev: number) => number): number =>
      updater(0),
    updateFileHistoryState: () => {},
    updateAttributionState: (
      updater: (prev: AttributionState) => AttributionState,
    ) => {
      options.attribution.state = updater(options.attribution.state)
    },
    messages: [],
  } as unknown as ToolUseContext
}

// ─── Round driver ────────────────────────────────────────────────────────

type DriverState = {
  history: Message[]
  approxTranscriptBytes: number
  compactKeep: number
  maxTurns: number
  toolUseContext: ToolUseContext
}

async function driveRound(
  mod: SrcModules,
  state: DriverState,
  round: ReplayRoundPlan,
  deps: QueryDeps,
  roundContext: RoundContext,
  canUseTool: QueryParams['canUseTool'],
): Promise<number> {
  const {
    query,
    createUserMessage,
    asSystemPrompt,
    createCompactBoundaryMessage,
  } = mod

  if (round.compactBoundary) {
    const boundary = createCompactBoundaryMessage(
      'manual',
      Math.floor(state.approxTranscriptBytes / 4),
      undefined,
      undefined,
      state.history.length,
    )
    const kept = state.history.slice(-state.compactKeep)
    state.history = [boundary, ...kept]
  }

  state.history.push(createUserMessage({ content: round.prompt }))

  roundContext.round = round
  roundContext.callIndexInRound = 0
  roundContext.approxInputTokens = Math.floor(state.approxTranscriptBytes / 4)

  let synthesizedMessages = 0
  for await (const msg of query({
    messages: [...state.history],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool,
    toolUseContext: state.toolUseContext,
    querySource: 'repl_main_thread',
    maxTurns: state.maxTurns,
    deps,
  })) {
    const kind = (msg as { type?: unknown }).type
    const hasUuid = typeof (msg as { uuid?: unknown }).uuid === 'string'
    if (
      (kind === 'assistant' ||
        kind === 'user' ||
        kind === 'system' ||
        kind === 'attachment') &&
      hasUuid
    ) {
      state.history.push(msg as Message)
      synthesizedMessages += 1
    }
  }

  state.approxTranscriptBytes +=
    round.prompt.length * 2 +
    (round.payloadSize ?? 0) +
    (round.oldString !== undefined && round.newString !== undefined
      ? (round.oldString.length + round.newString.length) * 2
      : 64)
  return synthesizedMessages
}

// ─── Attribution table ───────────────────────────────────────────────────

type ReplaySummary = {
  config: {
    messagesTarget: number
    seed: number
    ratios: ReplayCliOptions['ratios']
    payloadRangeBytes: [number, number]
    compactEvery: number
    gcEvery: number
    heapdumpEvery: number
  }
  stats: {
    rounds: number
    syntheticMessages: number
    durationMs: number
    compactCount: number
    payloadBytes: number
    editBytes: number
    attributionFiles: number
    roundKinds: Record<string, number>
  }
  rss: {
    startMB: number
    endMB: number
    deltaMB: number
    slopeBytesPerSec: number
    per1kMessagesMB: number
  }
  heapUsed: {
    startMB: number
    endMB: number
    deltaMB: number
  }
  postGc: {
    liveHeapStartMB: number
    liveHeapEndMB: number
    liveHeapDeltaMB: number
    rssStartMB: number
    rssEndMB: number
    rssDeltaMB: number
    probes: number
    cumulativeReclaimedMB: number
  }
  liveHeapShareOfRssGrowth: number
  verdict: string
  heapdump: string[]
}

export function buildSummary(args: {
  options: ReplayCliOptions
  stats: ReplaySummary['stats']
  samples: Array<MemSample & { tsSec: number }>
  gcProbes: Array<{ post: MemSample; pre: MemSample }>
  heapdumpFiles: string[]
}): ReplaySummary {
  const { options, stats, samples, gcProbes, heapdumpFiles } = args

  const rssSlope = olsSlope(samples.map(s => [s.tsSec, s.rss]))
  const first = samples[0]
  const last = samples[samples.length - 1]
  const firstGc = gcProbes[0]
  const lastGc = gcProbes[gcProbes.length - 1]

  const rssDelta = last && first ? last.rss - first.rss : 0
  const heapDelta = last && first ? last.heapUsed - first.heapUsed : 0
  const liveHeapDelta =
    firstGc && lastGc ? lastGc.post.heapUsed - firstGc.post.heapUsed : 0
  const postGcRssDelta =
    firstGc && lastGc ? lastGc.post.rss - firstGc.post.rss : 0

  const per1kMB =
    last && stats.syntheticMessages > 0
      ? rssDelta / (stats.syntheticMessages / 1000)
      : 0
  const liveShare =
    Math.abs(postGcRssDelta) > 1 ? liveHeapDelta / postGcRssDelta : 0

  let verdict: string
  if (liveHeapDelta > 0 && liveShare > 0.5) {
    verdict =
      'JS live heap dominates RSS growth — hunt the retainer graph (heapdiff ' +
      'name-level self-size deltas), not the allocator.'
  } else if (liveShare > 0.25) {
    verdict =
      'Mixed attribution: part live-heap growth, part allocator retention. ' +
      'Run with --heapdump and inspect the top name-level deltas first.'
  } else {
    verdict =
      'Allocator retention dominates (mimalloc keeps freed pages) — post-GC ' +
      'heap is flat-ish while RSS holds the bursts. GC-only fixes will not ' +
      'reclaim this RSS; reduce allocation bursts / session size instead.'
  }

  return {
    config: {
      messagesTarget: options.messages,
      seed: options.seed,
      ratios: options.ratios,
      payloadRangeBytes: [options.payloadMinBytes, options.payloadMaxBytes],
      compactEvery: options.compactEvery,
      gcEvery: options.gcEvery,
      heapdumpEvery: options.heapdumpEvery,
    },
    stats,
    rss: {
      startMB: first ? first.rss / (1024 * 1024) : 0,
      endMB: last ? last.rss / (1024 * 1024) : 0,
      deltaMB: rssDelta / (1024 * 1024),
      slopeBytesPerSec: rssSlope,
      per1kMessagesMB: per1kMB / (1024 * 1024),
    },
    heapUsed: {
      startMB: first ? first.heapUsed / (1024 * 1024) : 0,
      endMB: last ? last.heapUsed / (1024 * 1024) : 0,
      deltaMB: heapDelta / (1024 * 1024),
    },
    postGc: {
      liveHeapStartMB: firstGc ? firstGc.post.heapUsed / (1024 * 1024) : 0,
      liveHeapEndMB: lastGc ? lastGc.post.heapUsed / (1024 * 1024) : 0,
      liveHeapDeltaMB: liveHeapDelta / (1024 * 1024),
      rssStartMB: firstGc ? firstGc.post.rss / (1024 * 1024) : 0,
      rssEndMB: lastGc ? lastGc.post.rss / (1024 * 1024) : 0,
      rssDeltaMB: postGcRssDelta / (1024 * 1024),
      probes: gcProbes.length,
      cumulativeReclaimedMB:
        gcProbes.reduce(
          (acc, p) => acc + Math.max(0, p.pre.heapUsed - p.post.heapUsed),
          0,
        ) /
        (1024 * 1024),
    },
    liveHeapShareOfRssGrowth: liveShare,
    verdict,
    heapdump: heapdumpFiles,
  }
}

export function formatSummary(summary: ReplaySummary): string {
  const lines: string[] = []
  lines.push('== memory replay attribution ==')
  lines.push(
    `rounds=${summary.stats.rounds}  syntheticMessages=${summary.stats.syntheticMessages}  ` +
      `duration=${(summary.stats.durationMs / 1000).toFixed(1)}s`,
  )
  lines.push(
    `payloadBytes≈${formatBytes(summary.stats.payloadBytes)}  ` +
      `editBytes≈${formatBytes(summary.stats.editBytes)}  ` +
      `compactBoundaries=${summary.stats.compactCount}  ` +
      `kinds=${JSON.stringify(summary.stats.roundKinds)}`,
  )
  lines.push('')
  lines.push(
    `${padEnd('RSS', 14)}${padStart(fmtMB(summary.rss.startMB * 1024 * 1024), 9)} → ` +
      `${padStart(fmtMB(summary.rss.endMB * 1024 * 1024), 9)}  ` +
      `(Δ ${summary.rss.deltaMB >= 0 ? '+' : ''}${summary.rss.deltaMB.toFixed(1)}MB, ` +
      `${(summary.rss.slopeBytesPerSec / (1024 * 1024)).toFixed(2)}MB/s, ` +
      `${summary.rss.per1kMessagesMB.toFixed(2)}MB/1k msgs)`,
  )
  lines.push(
    `${padEnd('heapUsed', 14)}${padStart(fmtMB(summary.heapUsed.startMB * 1024 * 1024), 9)} → ` +
      `${padStart(fmtMB(summary.heapUsed.endMB * 1024 * 1024), 9)}  ` +
      `(Δ ${summary.heapUsed.deltaMB >= 0 ? '+' : ''}${summary.heapUsed.deltaMB.toFixed(1)}MB)`,
  )
  lines.push(
    `${padEnd('post-GC heap', 14)}${padStart(fmtMB(summary.postGc.liveHeapStartMB * 1024 * 1024), 9)} → ` +
      `${padStart(fmtMB(summary.postGc.liveHeapEndMB * 1024 * 1024), 9)}  ` +
      `(Δ ${summary.postGc.liveHeapDeltaMB >= 0 ? '+' : ''}${summary.postGc.liveHeapDeltaMB.toFixed(1)}MB)  ← JS live heap`,
  )
  lines.push(
    `${padEnd('post-GC RSS', 14)}${padStart(fmtMB(summary.postGc.rssStartMB * 1024 * 1024), 9)} → ` +
      `${padStart(fmtMB(summary.postGc.rssEndMB * 1024 * 1024), 9)}  ` +
      `(Δ ${summary.postGc.rssDeltaMB >= 0 ? '+' : ''}${summary.postGc.rssDeltaMB.toFixed(1)}MB)  ← allocator-held`,
  )
  lines.push(
    `gc probes=${summary.postGc.probes}  cumulative reclaimed=${summary.postGc.cumulativeReclaimedMB.toFixed(1)}MB`,
  )
  lines.push(
    `live-heap share of RSS growth: ${(summary.liveHeapShareOfRssGrowth * 100).toFixed(1)}%`,
  )
  lines.push(`verdict: ${summary.verdict}`)
  if (summary.heapdump.length > 0) {
    lines.push('heapdumps:')
    for (const f of summary.heapdump) {
      lines.push(`  ${f}`)
    }
  }
  return lines.join('\n')
}

// ─── Main ────────────────────────────────────────────────────────────────

export const WARMUP_MESSAGES = 2

export async function runReplay(options: ReplayCliOptions): Promise<number> {
  installMacroShim()

  mkdirSync(options.out, { recursive: true })
  const configDir = mkdtempSync(join(tmpdir(), 'memrun-config-'))
  setupReplayEnvironment(configDir)
  const samplesPath = join(options.out, SAMPLE_FILE)

  const synthConfig: ReplaySynthConfig = {
    messages: options.messages,
    seed: options.seed,
    ratios: options.ratios,
    payloadMinBytes: options.payloadMinBytes,
    payloadMaxBytes: options.payloadMaxBytes,
    compactEvery: options.compactEvery,
    compactKeepMessages: options.compactKeep,
  }
  const synth = createReplaySynthesizer(synthConfig)
  const plannedKinds: Record<string, number> = {}
  for (const round of synth.plan) {
    plannedKinds[round.kind] = (plannedKinds[round.kind] ?? 0) + 1
  }
  process.stdout.write(
    `[memory-replay] plan: ${synth.stats.rounds} rounds → ${synth.stats.totalMessages} messages ` +
      `(target ${options.messages}), kinds=${JSON.stringify(plannedKinds)}, ` +
      `compact=${synth.stats.compactCount}, seed=${options.seed}\n`,
  )
  process.stdout.write(`[memory-replay] out: ${options.out}\n`)

  const mod = await loadSrcModules()

  // Hermetic session state — same recipe the offline query boundary test uses.
  mod.resetStateForTests()
  mod.setOriginalCwd(configDir)
  mod.setCwdState(configDir)
  mod.setProjectRoot(configDir)
  mod.setSessionPersistenceDisabled(true)

  const roundContext: RoundContext = {
    round: null,
    callIndexInRound: 0,
    approxInputTokens: 1,
  }
  const attribution: AttributionStore = { state: emptyAttributionState() }
  const tools = buildReplayTools(mod.buildTool, roundContext, synth)
  const toolUseContext = buildToolUseContext({ tools, attribution })
  const toolUseIdOut = { current: '' }
  const deps = buildScriptedDeps(roundContext, options.seed, toolUseIdOut)
  const canUseTool = async (
    _tool: Tool,
    input: Record<string, unknown>,
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> => ({
    behavior: 'allow',
    updatedInput: input,
  })

  const state: DriverState = {
    history: [],
    approxTranscriptBytes: 0,
    compactKeep: options.compactKeep,
    maxTurns: options.maxTurns,
    toolUseContext,
  }

  writeFileSync(samplesPath, '')

  const samples: Array<MemSample & { tsSec: number; round: number }> = []
  const gcProbes: Array<{
    tsSec: number
    round: number
    pre: MemSample
    post: MemSample
    gcMs: number
  }> = []
  const heapdumpFiles: string[] = []

  const origin = nowMs()
  const profileLine = (
    round: number,
    label: string,
    durationMs: number,
  ): void => {
    if (!options.profile) return
    const mem = sampleMemory()
    process.stderr.write(
      `[+${padStart((nowMs() - origin).toFixed(1), 10)}ms] ` +
        `(+${padStart(durationMs.toFixed(1), 8)}ms) ` +
        `round ${padStart(String(round), 5)} ${padEnd(label, 10)} ` +
        `| RSS: ${fmtMB(mem.rss)}, Heap: ${fmtMB(mem.heapUsed)}\n`,
    )
  }

  const dumpSnapshot = (label: string): string => {
    const path = join(options.out, `snapshot-${label}.heapsnapshot`)
    writeHeapSnapshot(path)
    heapdumpFiles.push(path)
    process.stdout.write(`[memory-replay] heapdump: ${path}\n`)
    return path
  }

  // Baseline: force GC so the starting point measures live data only.
  fullGc()
  const baselineTsSec = (nowMs() - origin) / 1000
  const baseline = sampleMemory()
  samples.push({ ...baseline, tsSec: baselineTsSec, round: 0 })
  appendFileSync(
    samplesPath,
    `${JSON.stringify({
      ts: baselineTsSec * 1000,
      phase: 'baseline',
      round: 0,
      ...baseline,
    })}\n`,
  )
  if (options.heapdumpEvery > 0) {
    dumpSnapshot('000000-start')
  }

  // Warmup: one short round so lazily-initialized module paths are hot before
  // the first measured round. Runs through the same pipeline, then is dropped.
  const warmup = createReplaySynthesizer({
    messages: WARMUP_MESSAGES,
    seed: options.seed,
    ratios: { short: 1, toolPair: 0, edit: 0 },
    payloadMinBytes: options.payloadMinBytes,
    payloadMaxBytes: options.payloadMaxBytes,
    compactEvery: 0,
    compactKeepMessages: options.compactKeep,
  })
  const warmupRound = warmup.plan[0]
  if (warmupRound) {
    const t0 = nowMs()
    await driveRound(mod, state, warmupRound, deps, roundContext, canUseTool)
    profileLine(0, 'warmup', nowMs() - t0)
  }

  let syntheticMessages = 0
  const seenKinds: Record<string, number> = {}
  let payloadBytesSoFar = 0

  for (const round of synth.plan) {
    const t0 = nowMs()
    const added = await driveRound(
      mod,
      state,
      round,
      deps,
      roundContext,
      canUseTool,
    )
    syntheticMessages += added
    seenKinds[round.kind] = (seenKinds[round.kind] ?? 0) + 1
    payloadBytesSoFar += round.payloadSize ?? 0

    const tsSec = (nowMs() - origin) / 1000
    const mem = sampleMemory()
    samples.push({ ...mem, tsSec, round: round.index })
    appendFileSync(
      samplesPath,
      `${JSON.stringify({
        ts: tsSec * 1000,
        phase: 'round',
        round: round.index,
        kind: round.kind,
        historyMsgs: state.history.length,
        syntheticMessages,
        approxTranscriptBytes: state.approxTranscriptBytes,
        payloadBytesSoFar,
        attributionFiles: attribution.state.fileStates.size,
        toolUseId: toolUseIdOut.current,
        ...mem,
      })}\n`,
    )
    profileLine(round.index, round.kind, nowMs() - t0)

    // Allocator-retention probe: full GC mid-run. The pre→post delta is what
    // the allocator was withholding from the OS at that moment.
    if (options.gcEvery > 0 && round.index % options.gcEvery === 0) {
      const pre = sampleMemory()
      const gcStart = nowMs()
      fullGc()
      const gcMs = nowMs() - gcStart
      const post = sampleMemory()
      gcProbes.push({ tsSec, round: round.index, pre, post, gcMs })
      appendFileSync(
        samplesPath,
        `${JSON.stringify({
          ts: (nowMs() - origin) * 1000,
          phase: 'gc',
          round: round.index,
          gcMs,
          preRss: pre.rss,
          preHeapUsed: pre.heapUsed,
          postRss: post.rss,
          postHeapUsed: post.heapUsed,
          gcFreedRss: pre.rss - post.rss,
          gcFreedHeap: pre.heapUsed - post.heapUsed,
          external: post.external,
          arrayBuffers: post.arrayBuffers,
        })}\n`,
      )
    }

    if (
      options.heapdumpEvery > 0 &&
      round.index % options.heapdumpEvery === 0
    ) {
      dumpSnapshot(`${String(round.index).padStart(6, '0')}-${round.kind}`)
    }
  }

  // Final probes — the "end" numbers the attribution table reads.
  const finalGcStart = nowMs()
  fullGc()
  const endTsSec = (nowMs() - origin) / 1000
  const endMem = sampleMemory()
  samples.push({ ...endMem, tsSec: endTsSec, round: synth.plan.length })
  gcProbes.push({
    tsSec: endTsSec,
    round: synth.plan.length,
    pre: endMem,
    post: endMem,
    gcMs: nowMs() - finalGcStart,
  })
  appendFileSync(
    samplesPath,
    `${JSON.stringify({
      ts: endTsSec * 1000,
      phase: 'end',
      round: synth.plan.length,
      ...endMem,
    })}\n`,
  )

  let endHeapdumpPath: string | null = null
  if (options.heapdumpEvery > 0) {
    endHeapdumpPath = dumpSnapshot('999999-end')
  }

  const summary = buildSummary({
    options,
    stats: {
      rounds: synth.plan.length,
      syntheticMessages,
      durationMs: nowMs() - origin,
      compactCount: synth.stats.compactCount,
      payloadBytes: synth.stats.payloadBytes,
      editBytes: synth.stats.editBytes,
      attributionFiles: attribution.state.fileStates.size,
      roundKinds: seenKinds,
    },
    samples,
    gcProbes,
    heapdumpFiles,
  })

  writeFileSync(
    join(options.out, SUMMARY_FILE),
    `${JSON.stringify(summary, null, 2)}\n`,
  )
  process.stdout.write(`${formatSummary(summary)}\n`)

  if (options.heapdumpEvery > 0 && heapdumpFiles.length >= 2) {
    const startPath = heapdumpFiles[0]!
    const endPath = endHeapdumpPath ?? heapdumpFiles[heapdumpFiles.length - 1]!
    try {
      process.stdout.write('\n== heapdump diff (start → end): top deltas ==\n')
      const report = await compareSnapshotFiles(startPath, endPath, {
        top: 10,
        focusKeywords: DEFAULT_FOCUS_KEYWORDS,
      })
      for (const row of report.topByNameDelta.slice(0, 10)) {
        process.stdout.write(
          `  ${padStart(formatBytes(row.deltaSize), 10)}  ` +
            `${padEnd(`${row.type} ${row.name}`.slice(0, 50), 52)} ` +
            `${row.countA}→${row.countB}\n`,
        )
      }
    } catch (err) {
      process.stdout.write(
        `[memory-replay] heapdump diff skipped: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      )
    }
  }

  process.stdout.write(
    `[memory-replay] done. samples=${samples.length} gcProbes=${gcProbes.length} ` +
      `attributionFiles=${attribution.state.fileStates.size}\n`,
  )
  return 0
}

async function main(): Promise<number> {
  const options = parseCliOptions(Bun.argv.slice(2))
  if (!options) {
    process.stderr.write(`${usage()}\n`)
    return 1
  }
  return runReplay(options)
}

if (import.meta.main) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      process.stderr.write(
        `memory-replay: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }\n`,
      )
      process.exit(1)
    })
}
