#!/usr/bin/env bun
/**
 * 差分对拍：增量维护的 MessageLookups 与全量重编逐操作等价性验证。
 *
 * 对同一变更操作流（追加 → tick 就地替换 → 编辑 → tombstone 过滤 →
 * 截断 → 全量替换 → 再追加，覆盖 REPL.tsx / query.ts 的全部消息数组
 * 变更模式），在每个操作后断言：
 *   1. 裸增量路径：updateMessageLookupsIncremental 从上一步"与全量重编
 *      等价的索引"出发，返回非 null 时其结果与 buildMessageLookups
 *      全量重编的规范化 JSON 完全相等；
 *   2. MessageLookupsCache（Messages.tsx 生产缓存策略，含每第 4 次
 *      变更全量重编兜底）的输出与全量重编完全相等。
 *
 * 用 ~/.claude/projects/ 下的真实转录驱动（最大的 JSONL + 20 个随机
 * 文件）；无转录时退化为合成会话。零 npm 依赖，直接驱动
 * src/utils/messageLookups.ts 的真实实现。
 *
 * 用法：bun scripts/differential-hotpath.ts
 * 退出码：0 = 全部相等；1 = 发现不等（打印首个差异）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildMessageLookups,
  computeMessageStructureKey,
  type MessageLookups,
  MessageLookupsCache,
  LOOKUPS_FULL_REBUILD_INTERVAL,
  updateMessageLookupsIncremental,
} from '../src/utils/messageLookups.ts'
import type { Message, NormalizedMessage } from '../src/types/message.ts'

// ─── 规范化序列化（Map/Set 展开，对象键排序，Map/Set 保持插入序） ───

function canon(value: unknown): unknown {
  if (value instanceof Map) {
    return { __map: [...value].map(([k, v]) => [k, canon(v)]) }
  }
  if (value instanceof Set) {
    return { __set: [...value].map(canon) }
  }
  if (Array.isArray(value)) {
    return value.map(canon)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const obj = value as Record<string, unknown>
    for (const key of Object.keys(obj).sort()) {
      out[key] = canon(obj[key])
    }
    return out
  }
  return value
}

function canonJson(lookups: MessageLookups): string {
  return JSON.stringify(canon(lookups))
}

// ─── 转录加载与轻量规范化 ────────────────────────────────────────────

type Entry = Record<string, unknown>

const MESSAGE_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'progress',
  'attachment',
])

/** 轻量规范化：保留 lookups 消费的形状（uuid 兜底），不引入 messages.ts 依赖链。 */
function normalize(entries: Entry[]): NormalizedMessage[] {
  return entries.map((entry, i) => {
    const msg = { ...entry } as NormalizedMessage
    if (!msg.uuid) {
      ;(msg as { uuid: string }).uuid = `n-${i}`
    }
    return msg
  })
}

function parseTranscript(path: string, maxMessages: number): Entry[] {
  const text = readFileSync(path, 'utf8')
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let parsed: Entry
    try {
      parsed = JSON.parse(line) as Entry
    } catch {
      continue
    }
    if (
      MESSAGE_TYPES.has(parsed.type as string) &&
      (parsed.uuid || parsed.message || parsed.attachment || parsed.data)
    ) {
      out.push(parsed)
      if (out.length >= maxMessages) break
    }
  }
  return out
}

function discoverTranscripts(): { largest: string; others: string[] } | null {
  const root = join(process.env.HOME ?? homedir(), '.claude', 'projects')
  const files: Array<{ path: string; size: number }> = []
  try {
    for (const dir of readdirSync(root)) {
      try {
        for (const file of readdirSync(join(root, dir))) {
          if (!file.endsWith('.jsonl')) continue
          const path = join(root, dir, file)
          files.push({ path, size: statSync(path).size })
        }
      } catch {
        // 子目录不可读 — 跳过
      }
    }
  } catch {
    return null
  }
  if (files.length === 0) return null
  files.sort((a, b) => b.size - a.size)
  const largest = files[0]!.path
  const rest = files.slice(1)
  // 20 个随机文件（确定性种子，保证跨修订可比）
  let seed = 0x9e3779b9
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
  }
  return { largest, others: rest.slice(0, 20).map(f => f.path) }
}

/** 合成会话：工具调用 / hook attachment / progress / server_tool_use 混合。 */
function syntheticSession(i: number): Entry[] {
  const entries: Entry[] = []
  for (let t = 0; t < 60; t++) {
    const tu = `tu-${i}-${t}`
    entries.push({
      type: 'assistant',
      uuid: `a-${i}-${t}`,
      message: {
        id: `msg-${i}-${t}`,
        role: 'assistant',
        content: [
          { type: 'text', text: `thinking step ${t}` },
          { type: 'tool_use', id: tu, name: 'Bash', input: { cmd: 'ls' } },
        ],
      },
    })
    if (t % 3 === 0) {
      entries.push({
        type: 'progress',
        uuid: `p-${i}-${t}`,
        parentToolUseID: tu,
        data: { type: 'hook_progress', hookEvent: 'PreToolUse' },
      })
    }
    if (t % 2 === 0) {
      entries.push({
        type: 'attachment',
        uuid: `h-${i}-${t}`,
        attachment: {
          type: 'hook_success',
          toolUseID: tu,
          hookEvent: 'PostToolUse',
          hookName: `hook-${t % 2}`,
        },
      })
    }
    entries.push({
      type: 'user',
      uuid: `u-${i}-${t}`,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: tu,
            content: `result ${t}`,
            ...(t % 7 === 0 ? { is_error: true } : {}),
          },
        ],
      },
    })
  }
  return entries
}

// ─── 操作流驱动 ──────────────────────────────────────────────────────

const stats = {
  files: 0,
  ops: 0,
  append: 0,
  tickReplace: 0,
  edit: 0,
  tombstone: 0,
  truncate: 0,
  fullReplace: 0,
  rawIncrementalApplied: 0,
  rawIncrementalNulls: 0,
  cacheReuses: 0,
  cacheIncremental: 0,
  cacheFull: 0,
  equalityChecks: 0,
  boundedDriftConverged: 0,
}

let tickCounter = 0

function lastAssistantId(messages: Message[]): string | undefined {
  const last = messages.at(-1)
  return last?.type === 'assistant'
    ? (last as { message?: { id?: string } }).message?.id
    : undefined
}

/** 单文件差分：在 base + 剩余消息池上循环施加全部变更模式。 */
function runFile(label: string, entries: Entry[]): void {
  const baseLen = Math.min(120, Math.floor(entries.length / 4))
  let messages = normalize(entries.slice(0, baseLen)) as unknown as Message[]
  const pool = normalize(entries.slice(baseLen)) as unknown as Message[]
  if (messages.length === 0) return

  const cache = new MessageLookupsCache()
  let poolIdx = 0

  // 裸增量路径的状态：始终从"与全量重编等价"的索引出发
  let rawLookups = buildMessageLookups(
    messages as unknown as NormalizedMessage[],
    messages,
  )
  let rawNormalizedCount = messages.length
  let rawMessageCount = messages.length

  const check = (op: string): void => {
    const normalized = messages as unknown as NormalizedMessage[]
    const full = buildMessageLookups(normalized, messages)

    // 1) 生产缓存（含每第 4 次变更全量重编兜底）
    const cached = cache.get(normalized, messages, lastAssistantId(messages))
    const cachedJson = canonJson(cached)
    const fullJson = canonJson(full)
    stats.equalityChecks++
    if (cachedJson !== fullJson) {
      fail(
        label,
        op,
        `MessageLookupsCache 输出与全量重编不等`,
        cachedJson,
        fullJson,
      )
    }

    // 2) 裸增量路径：与生产缓存一致，仅对"至少一个数组严格增长"的
    //    纯追加场景应用增量（等长结构变更必须全量重编，见
    //    MessageLookupsCache.get 的严格增长守卫）；其余场景重置为
    //    全量重编等价状态。
    if (
      (normalized.length > rawNormalizedCount ||
        messages.length > rawMessageCount) &&
      normalized.length >= rawNormalizedCount &&
      messages.length >= rawMessageCount
    ) {
      const inc = updateMessageLookupsIncremental(
        rawLookups,
        rawNormalizedCount,
        rawMessageCount,
        normalized,
        messages,
      )
      if (inc !== null) {
        stats.equalityChecks++
        const incJson = canonJson(inc)
        if (incJson !== fullJson) {
          fail(label, op, `增量索引与全量重编不等`, incJson, fullJson)
        }
        stats.rawIncrementalApplied++
      } else {
        stats.rawIncrementalNulls++
      }
    } else {
      stats.rawIncrementalNulls++
    }
    rawLookups = full
    rawNormalizedCount = normalized.length
    rawMessageCount = messages.length
  }

  const fail = (
    file: string,
    op: string,
    what: string,
    got: string,
    want: string,
  ): never => {
    console.error(`[FAIL] ${what} file=${file} op=${op} ops=${stats.ops}`)
    console.error(`  统计: ${JSON.stringify(stats)}`)
    console.error(`  got =${got.slice(0, 2400)}`)
    console.error(`  want=${want.slice(0, 2400)}`)
    process.exit(1)
  }

  let mode = 0
  while (poolIdx < pool.length) {
    stats.ops++
    mode = (mode + 1) % 6
    switch (mode) {
      case 0:
      case 1: {
        // 追加 1-5 条（流式 delta）
        const batch = pool.slice(poolIdx, poolIdx + 1 + (stats.ops % 5))
        poolIdx += batch.length
        messages = messages.concat(batch)
        stats.append++
        check('append')
        break
      }
      case 2: {
        // 尾部 progress tick 就地替换（同长度、新 uuid）
        const last = messages.at(-1) as Record<string, unknown> | undefined
        if (last?.type === 'progress') {
          tickCounter++
          const replacement = {
            ...last,
            uuid: `tick-${tickCounter}`,
          } as unknown as Message
          const copy = messages.slice()
          copy[copy.length - 1] = replacement
          messages = copy
          stats.tickReplace++
          check('tickReplace')
        } else {
          messages = messages.concat(pool.slice(poolIdx, poolIdx + 1))
          poolIdx++
          stats.append++
          check('append-fallback')
        }
        break
      }
      case 3: {
        // 编辑：替换中间一条 user 消息内容（同 uuid，新 content）
        const idx = messages.findIndex(
          m => (m as { type: string }).type === 'user',
        )
        if (idx > 0) {
          const target = messages[idx] as unknown as Record<string, unknown>
          const copy = messages.slice()
          ;(copy as unknown as Record<string, unknown>[])[idx] = {
            ...target,
            message: { role: 'user', content: `edited @${stats.ops}` },
          }
          messages = copy
          stats.edit++
          check('edit')
        } else {
          messages = messages.concat(pool.slice(poolIdx, poolIdx + 1))
          poolIdx++
          stats.append++
          check('append-fallback')
        }
        break
      }
      case 4: {
        // tombstone 过滤：移除中间一条
        if (messages.length > 4) {
          const idx = 1 + (stats.ops % (messages.length - 2))
          messages = messages.slice(0, idx).concat(messages.slice(idx + 1))
          stats.tombstone++
          check('tombstone')
        } else {
          messages = messages.concat(pool.slice(poolIdx, poolIdx + 1))
          poolIdx++
          stats.append++
          check('append-fallback')
        }
        break
      }
      case 5: {
        // 截断（rewind）后继续追加
        const keep = Math.max(2, Math.floor(messages.length / 2))
        messages = messages.slice(0, keep)
        stats.truncate++
        check('truncate')
        const batch = pool.slice(poolIdx, poolIdx + 2)
        poolIdx += batch.length
        messages = messages.concat(batch)
        stats.append++
        check('truncate+append')
        break
      }
    }
  }

  // 全量替换（compact：整组换新 — REPL.tsx 的 setMessages(() => [...])）
  const keep = messages.slice(Math.max(0, messages.length - 40))
  messages = (
    [
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: `cb-${stats.ops}`,
      },
    ] as unknown as Message[]
  ).concat(keep)
  stats.fullReplace++
  check('fullReplace')
  const tail = pool.slice(-3)
  messages = messages.concat(tail)
  stats.append++
  check('fullReplace+append')

  stats.files++
}

/**
 * 有界漂移验证：结构键不可见的就地内容变更（如 tool_result 的 is_error
 * 翻转 — 键只含 tool_use_id），增量索引允许短暂滞后，但必须在
 * LOOKUPS_FULL_REBUILD_INTERVAL 次变更内被全量重编兜底收敛回等价。
 */
function runBoundedDrift(label: string): void {
  const toolUseID = `${label}-tu-1`
  const mkUser = (change: number, isError: boolean): Message =>
    ({
      type: 'user',
      uuid: `${label}-u1`,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseID,
            content: `r-${change}`,
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    }) as unknown as Message
  let messages: Message[] = [
    {
      type: 'assistant',
      uuid: `${label}-a1`,
      message: {
        id: `${label}-msg1`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input: {} }],
      },
    } as unknown as Message,
    mkUser(0, false),
  ]
  const cache = new MessageLookupsCache()
  const lastId = () => lastAssistantId(messages)
  // 基线：is_error 缺省（erroredToolUseIDs 为空）的全量重编
  cache.get(
    messages.map(m => ({ ...m })) as unknown as NormalizedMessage[],
    messages,
    lastId(),
  )
  let convergedAt = -1
  for (let change = 1; change <= LOOKUPS_FULL_REBUILD_INTERVAL; change++) {
    // 结构键不可见的就地内容变更：is_error 置 true（键只含
    // tool_use_id，is_error 不入键），content 每次变化保持单调漂移。
    const copy = messages.slice()
    copy[1] = mkUser(change, true)
    messages = copy
    const normalized = messages as unknown as NormalizedMessage[]
    const cached = cache.get(normalized, messages, lastId())
    const full = buildMessageLookups(normalized, messages)
    if (canonJson(cached) === canonJson(full)) {
      convergedAt = change
      break
    }
  }
  if (convergedAt !== LOOKUPS_FULL_REBUILD_INTERVAL) {
    console.error(
      `[FAIL-DRIFT] file=${label} 漂移在第 ${convergedAt} 次变更收敛（期望第 ${LOOKUPS_FULL_REBUILD_INTERVAL} 次）`,
    )
    process.exit(1)
  }
  stats.boundedDriftConverged = (stats.boundedDriftConverged ?? 0) + 1
}

// ─── 主流程 ──────────────────────────────────────────────────────────

const MAX_PER_FILE = Number(process.env.DIFF_MAX_MESSAGES ?? 4000)
const discovered = discoverTranscripts()

if (discovered) {
  console.error(
    `[diff] 最大转录: ${discovered.largest} (${(statSync(discovered.largest).size / 1e6).toFixed(1)} MB)`,
  )
  runFile('largest', parseTranscript(discovered.largest, MAX_PER_FILE))
  for (const path of discovered.others) {
    runFile(path.split('/').pop() ?? path, parseTranscript(path, MAX_PER_FILE))
  }
} else {
  console.error('[diff] 未找到 ~/.claude/projects/ 转录，使用合成会话')
}
for (let i = 0; i < 3; i++) {
  runFile(`synthetic-${i}`, syntheticSession(i))
}
runBoundedDrift('drift-a')
runBoundedDrift('drift-b')

console.log(
  JSON.stringify(
    {
      ok: true,
      files: stats.files,
      ops: stats.ops,
      opsByKind: {
        append: stats.append,
        tickReplace: stats.tickReplace,
        edit: stats.edit,
        tombstone: stats.tombstone,
        truncate: stats.truncate,
        fullReplace: stats.fullReplace,
      },
      rawIncremental: {
        applied: stats.rawIncrementalApplied,
        forcedFull: stats.rawIncrementalNulls,
      },
      equalityChecks: stats.equalityChecks,
      boundedDriftConverged: stats.boundedDriftConverged,
      source: discovered ? 'real-transcripts' : 'synthetic-only',
    },
    null,
    2,
  ),
)
