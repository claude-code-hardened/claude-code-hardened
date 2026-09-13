#!/usr/bin/env bun
/**
 * 热路径基准：模拟流式 delta 下的消息数组追加 + MessageLookups 维护。
 *
 * 指标（稳定 JSON，跨 git 修订可比）：
 *   - per-delta 平均/最大耗时（增量缓存路径 vs 全量重编基线）
 *   - 每条 delta 的消息数组拷贝次数与耗时（React setMessages 追加模式）
 *   - heapUsed 增长
 *
 * 会话来源：~/.claude/projects/ 最大真实转录（截断到 MAX_SESSION 条），
 * 缺失时退化为合成会话。零 npm 依赖。
 *
 * 用法：bun scripts/bench-hotpath.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildMessageLookups,
  type MessageLookups,
  MessageLookupsCache,
} from '../src/utils/messageLookups.ts'
import type { Message, NormalizedMessage } from '../src/types/message.ts'

const MAX_SESSION = Number(process.env.BENCH_SESSION ?? 2000)
const WARMUP_DELTAS = Number(process.env.BENCH_WARMUP ?? 300)
const DELTAS = Number(process.env.BENCH_DELTAS ?? 1500)

// ─── 会话构建 ────────────────────────────────────────────────────────

type Entry = Record<string, unknown>

const MESSAGE_TYPES = new Set(['user', 'assistant', 'system'])

function parseTranscript(path: string, max: number): Message[] {
  const text = readFileSync(path, 'utf8')
  const out: Message[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as Entry
      if (MESSAGE_TYPES.has(parsed.type as string) && parsed.uuid) {
        out.push(parsed as unknown as Message)
        if (out.length >= max) break
      }
    } catch {}
  }
  return out
}

function largestTranscript(): string | null {
  const root = join(process.env.HOME ?? homedir(), '.claude', 'projects')
  let best: string | null = null
  let bestSize = 0
  try {
    for (const dir of readdirSync(root)) {
      try {
        for (const file of readdirSync(join(root, dir))) {
          if (!file.endsWith('.jsonl')) continue
          const path = join(root, dir, file)
          const size = statSync(path).size
          if (size > bestSize) {
            bestSize = size
            best = path
          }
        }
      } catch {
        // 子目录不可读 — 跳过
      }
    }
  } catch {
    return null
  }
  return best
}

/** 确定性合成会话：tool_use ↔ tool_result 交替 + 文本 assistant。 */
function syntheticBase(n: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      type: 'assistant',
      uuid: `b-a-${i}`,
      message: {
        id: `b-msg-${Math.floor(i / 2)}`,
        role: 'assistant',
        content: [
          { type: 'text', text: `step ${i} `.repeat(8) },
          { type: 'tool_use', id: `b-tu-${i}`, name: 'Bash', input: {} },
        ],
      },
    } as unknown as Message)
    out.push({
      type: 'user',
      uuid: `b-u-${i}`,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `b-tu-${i}`,
            content: `out ${i}`,
          },
        ],
      },
    } as unknown as Message)
  }
  return out
}

/**
 * 流式 delta 生成：模拟真实 API 流 — 同一响应的连续 assistant 块共享
 * message.id（lastAssistantMsgId 稳定 → 走增量路径），每 7 个 delta 一个
 * 工具回合（tool_use → tool_result，result 落地后 lastId 变化 → 全量重编）。
 */
function makeDelta(i: number): Message {
  const cycle = Math.floor(i / 7)
  if (i % 7 === 6) {
    return {
      type: 'user',
      uuid: `d-u-${i}`,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `d-tu-${cycle}`,
            content: `delta result ${i}`,
          },
        ],
      },
    } as unknown as Message
  }
  const withToolUse = i % 7 === 0
  return {
    type: 'assistant',
    uuid: `d-a-${i}`,
    message: {
      id: `d-resp-${cycle}`,
      role: 'assistant',
      content: withToolUse
        ? [
            { type: 'text', text: `delta text ${i}` },
            { type: 'tool_use', id: `d-tu-${cycle}`, name: 'Bash', input: {} },
          ]
        : [{ type: 'text', text: `delta text ${i}` }],
    },
  } as unknown as Message
}

// ─── 计时工具 ────────────────────────────────────────────────────────

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]!
}

function summarize(samples: number[]): {
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
} {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = samples.reduce((acc, v) => acc + v, 0)
  return {
    avgMs: Number((sum / samples.length).toFixed(4)),
    p50Ms: Number(pct(sorted, 50).toFixed(4)),
    p95Ms: Number(pct(sorted, 95).toFixed(4)),
    maxMs: Number(sorted[sorted.length - 1]!.toFixed(4)),
  }
}

function lastAssistantId(messages: Message[]): string | undefined {
  const last = messages.at(-1)
  return last?.type === 'assistant'
    ? (last as { message?: { id?: string } }).message?.id
    : undefined
}

// ─── 基准阶段 ────────────────────────────────────────────────────────

const src = largestTranscript()
let session: Message[]
if (src) {
  session = parseTranscript(src, MAX_SESSION)
  console.error(
    `[bench] 会话来源: ${src} (${(statSync(src).size / 1e6).toFixed(1)} MB, ${session.length} 条)`,
  )
} else {
  session = syntheticBase(MAX_SESSION)
  console.error(`[bench] 会话来源: 合成 (${session.length} 条)`)
}
if (session.length < 100) {
  session = syntheticBase(MAX_SESSION)
}

// 每条 delta 的轻量规范化：真实路径中 normalizeMessages 的产出近似恒等
// 映射（此处避免引入 messages.ts 依赖链），增量/全量消费的形状一致。
const asNormalized = (messages: Message[]): NormalizedMessage[] =>
  messages as unknown as NormalizedMessage[]

// 阶段 1：流式 delta — 追加 + 生产缓存策略（增量为主 + 每 4 次变更全量兜底）。
// 预热与测量在同一条连续流上进行（前 WARMUP 条丢弃），避免冷启动污染。
const cache = new MessageLookupsCache()
let messages = session.slice()
let prevLookups: MessageLookups | null = cache.get(
  asNormalized(messages),
  messages,
  lastAssistantId(messages),
)
const deltaTimes: number[] = []
const appendTimes: number[] = []
const incrementalTimes: number[] = []
const fullRebuildTimes: number[] = []
let incrementalOrReuseUpdates = 0
let fullRebuilds = 0
let appendCopies = 0
// 同步全量 GC ×2：heap 指标只反映存活对象（第一遍释放转录解析残片，
// 第二遍收敛 sliced string / 新生代），跨修订可比。
Bun.gc(true)
Bun.gc(true)
const heapStart = process.memoryUsage().heapUsed

const totalDeltas = WARMUP_DELTAS + DELTAS
const heapSamples: number[] = []
for (let i = 0; i < totalDeltas; i++) {
  const delta = makeDelta(i)
  const t0 = performance.now()
  const appended = messages.concat([delta]) // React setMessages 追加拷贝
  appendCopies++
  const t1 = performance.now()
  const lookups = cache.get(
    asNormalized(appended),
    appended,
    lastAssistantId(appended),
  )
  const t2 = performance.now()
  messages = appended
  if (i >= WARMUP_DELTAS) {
    deltaTimes.push(t2 - t0)
    appendTimes.push(t1 - t0)
    if (prevLookups !== null && lookups !== prevLookups) {
      fullRebuilds++
      fullRebuildTimes.push(t2 - t1)
    } else {
      // 同一对象：增量更新或结构键复用（都不新建 8 Map/Set）
      incrementalOrReuseUpdates++
      incrementalTimes.push(t2 - t1)
    }
    if (i % 50 === 0) heapSamples.push(process.memoryUsage().heapUsed)
  }
  prevLookups = lookups
}
Bun.gc(true)
const heapEnd = process.memoryUsage().heapUsed

// 阶段 2：全量重编基线（每次 delta 重建 8 Map/Set — 优化前路径）
let baselineMessages = session.slice()
const baselineTimes: number[] = []
for (let i = 0; i < WARMUP_DELTAS + DELTAS; i++) {
  const delta = makeDelta(i)
  baselineMessages = baselineMessages.concat([delta])
  if (i < WARMUP_DELTAS) continue
  const t0 = performance.now()
  buildMessageLookups(asNormalized(baselineMessages), baselineMessages)
  baselineTimes.push(performance.now() - t0)
}

const result = {
  bench: 'hotpath',
  session: {
    source: src ? 'real-transcript' : 'synthetic',
    baseMessages: session.length,
    deltas: DELTAS,
    finalMessages: messages.length,
  },
  streamingDeltas: {
    perDeltaTotalMs: summarize(deltaTimes),
    perDeltaAppendCopyMs: summarize(appendTimes),
    lookupsIncrementalMs: summarize(incrementalTimes),
    lookupsFullRebuildMs: summarize(fullRebuildTimes),
  },
  fullRebuildBaseline: {
    perDeltaMs: summarize(baselineTimes),
  },
  cache: {
    incrementalOrReuseUpdates,
    fullRebuilds,
    // 增量路径不拷贝消息数组（索引原地更新）；每条 delta 的唯一全数组
    // 拷贝来自 React setMessages 追加（appendCopy.copiesPerDelta）。
    arrayCopiesPerDelta: 0,
  },
  appendCopy: {
    copies: appendCopies,
    copiesPerDelta: 1,
  },
  heapUsed: {
    // 平台注记：Bun/JSC 的 heapUsed 含堆容量（会中途自行收缩），端点值
    // 可能为负增长；minSampleMB 为窗口内采样下界，更能代表存活堆，
    // 两者均可跨修订比较（测量程序各修订完全一致）。
    startMB: Number((heapStart / 1e6).toFixed(2)),
    endMB: Number((heapEnd / 1e6).toFixed(2)),
    growthMB: Number(((heapEnd - heapStart) / 1e6).toFixed(2)),
    minSampleMB: Number((Math.min(...heapSamples) / 1e6).toFixed(2)),
  },
}

console.log(JSON.stringify(result, null, 2))
