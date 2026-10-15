/**
 * Deterministic transcript synthesizer for scripts/memory-replay.ts.
 *
 * Pure module on purpose: no src/ imports, no I/O, no wall-clock reads. All
 * randomness flows through a seeded PRNG so a given (config) produces an
 * identical round plan across runs — the precondition for reproducible
 * memory measurements.
 *
 * Message-count model (kept simple and stable so `--messages N` maps to a
 * predictable number of query rounds):
 *   short      → 2 messages (user prompt + assistant text)
 *   tool_pair  → 4 messages (prompt + assistant[tool_use] + user[tool_result]
 *                 + assistant text)
 *   edit       → 4 messages (prompt + assistant[tool_use] + user[tool_result
 *                 with patch-shaped toolUseResult] + assistant text)
 *   compact    → +1 message (system compact_boundary) applied BEFORE the round
 *                 that carries it
 *
 * The loop stops as soon as the synthesized message count reaches the target,
 * so the total can overshoot the target by at most MESSAGES_PER_ROUND + 1.
 */

export type ReplayRoundKind = 'short' | 'tool_pair' | 'edit'

export type ReplayRoundPlan = {
  /** 1-based round index. */
  index: number
  kind: ReplayRoundKind
  /** User prompt text for this round (deterministic). */
  prompt: string
  /** tool_pair only: exact byte length of the synthetic tool payload. */
  payloadSize?: number
  /** Virtual file path (edit target; also used in tool_pair prompts). */
  file: string
  /** edit only: old/new strings of the simulated patch. */
  oldString?: string
  newString?: string
  /** Simulated /compact boundary to apply BEFORE this round runs. */
  compactBoundary: boolean
}

export type ReplaySynthConfig = {
  /** Target number of synthetic transcript messages. */
  messages: number
  seed: number
  /** Relative weights per round kind (not probabilities; normalized internally). */
  ratios: { short: number; toolPair: number; edit: number }
  /** Inclusive lower bound of tool payload sizes in bytes. */
  payloadMinBytes: number
  /** Inclusive upper bound of tool payload sizes in bytes. */
  payloadMaxBytes: number
  /** Emit a simulated /compact boundary every N rounds (0 = never). */
  compactEvery: number
  /** Messages kept after a compact boundary (excluding the boundary itself). */
  compactKeepMessages: number
}

export type ReplaySynthStats = {
  rounds: number
  totalMessages: number
  compactCount: number
  promptBytes: number
  payloadBytes: number
  editBytes: number
}

export const MESSAGES_PER_ROUND: Record<ReplayRoundKind, number> = {
  short: 2,
  tool_pair: 4,
  edit: 4,
}

const EDIT_FILE_POOL_SIZE = 128
/** Virtual file content budget per edit target (bytes). */
const MAX_VIRTUAL_FILE_BYTES = 64 * 1024
/** Size of one patch (old_string/new_string) fed to the edit tool (bytes). */
export const EDIT_PATCH_BYTES = 4 * 1024
/** Seed content every virtual file starts from (deterministic). */
export const VIRTUAL_FILE_INITIAL = (file: string): string =>
  [
    `// ${file} — virtual replay target`,
    'export function placeholder() {',
    '  return 0',
    '}',
    '',
  ].join('\n') + `${file}\n`.repeat(64)

/** mulberry32 — tiny deterministic PRNG, seedable, sufficient for replay. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function nextRandom(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Deterministic payload content of EXACTLY `size` bytes. The first line
 * embeds the caller-provided unique tag (so different tool calls differ),
 * the rest is a positional tile pattern — never constant-foldable, cheap to
 * build, reproducible across runs and processes.
 */
export function buildPayload(unique: string, size: number): string {
  const tile = `0123456789abcdef|${unique}|`
  const chunks: string[] = [`PAYLOAD ${unique} bytes=${size} `]
  let written = chunks[0]!.length
  while (written < size) {
    chunks.push(tile)
    written += tile.length
  }
  const joined = chunks.join('')
  if (joined.length > size) {
    return joined.slice(0, size)
  }
  if (joined.length < size) {
    return joined + 'x'.repeat(size - joined.length)
  }
  return joined
}

/** Pick a round kind from weighted ratios (missing/zero ratios tolerated). */
export function pickRoundKind(
  rnd: () => number,
  ratios: ReplaySynthConfig['ratios'],
): ReplayRoundKind {
  const weighted: Array<[ReplayRoundKind, number]> = [
    ['short', Math.max(0, ratios.short)],
    ['tool_pair', Math.max(0, ratios.toolPair)],
    ['edit', Math.max(0, ratios.edit)],
  ]
  const total = weighted.reduce((acc, [, w]) => acc + w, 0)
  if (total <= 0) {
    return 'short'
  }
  let threshold = rnd() * total
  for (const [kind, weight] of weighted) {
    threshold -= weight
    if (threshold < 0) {
      return kind
    }
  }
  return weighted[weighted.length - 1]![0]
}

type VirtualFileEdit = { roundIndex: number; newString: string }

type VirtualFiles = Map<string, VirtualFileEdit[]>

/**
 * Content of `file` as of the end of `roundIndex` (all edits with
 * `edit.roundIndex <= roundIndex` applied). Append-only edits + cap keep this
 * deterministic and cheap.
 */
function virtualFileContent(
  files: VirtualFiles,
  file: string,
  roundIndex: number,
): string {
  const edits = files.get(file)
  let content = VIRTUAL_FILE_INITIAL(file)
  if (!edits) {
    return content
  }
  for (const edit of edits) {
    if (edit.roundIndex > roundIndex) {
      break
    }
    content = `${content}${edit.newString}`
    if (content.length > MAX_VIRTUAL_FILE_BYTES) {
      content = content.slice(0, MAX_VIRTUAL_FILE_BYTES)
    }
  }
  return content
}

export type ReplaySynthesizer = {
  plan: ReplayRoundPlan[]
  stats: ReplaySynthStats
  /**
   * Content of a virtual file as it should exist after all edit rounds up to
   * `roundIndex`. The replay driver's fake edit tool uses this to produce
   * structuredPatch / originalFile / updatedFile tool results. Deterministic.
   */
  virtualFileAfter: (roundIndex: number, file: string) => string
}

/** Build one deterministic edit patch against a virtual file's content. */
function makeEditPatch(
  rnd: () => number,
  file: string,
  roundIndex: number,
  content: string,
): { oldString: string; newString: string } {
  const maxStart = Math.max(0, content.length - EDIT_PATCH_BYTES)
  const start = Math.floor(rnd() * (maxStart + 1))
  const oldString = content.slice(start, start + EDIT_PATCH_BYTES)
  const newString = `${oldString}\n// replay-edit r${roundIndex}`
  return { oldString, newString }
}

/**
 * Generate the full scripted round plan up front. Everything is derived from
 * (config, PRNG) only — same seed + config ⇒ byte-identical plan.
 */
export function createReplaySynthesizer(
  config: ReplaySynthConfig,
): ReplaySynthesizer {
  const rnd = mulberry32(config.seed)
  const plan: ReplayRoundPlan[] = []
  const virtualFiles: VirtualFiles = new Map()

  let synthMessages = 0
  let compactCount = 0
  let promptBytes = 0
  let payloadBytes = 0
  let editBytes = 0
  let index = 0

  while (synthMessages < config.messages) {
    index += 1
    const kind = pickRoundKind(rnd, config.ratios)
    const file = `src/generated/module-${index % EDIT_FILE_POOL_SIZE}.ts`

    let payloadSize: number | undefined
    let oldString: string | undefined
    let newString: string | undefined
    let prompt: string

    if (kind === 'short') {
      prompt = `User turn ${index}: review the dashboard widget layout and summarize the churn`
    } else if (kind === 'tool_pair') {
      const span = Math.max(0, config.payloadMaxBytes - config.payloadMinBytes)
      payloadSize = config.payloadMinBytes + Math.floor(rnd() * (span + 1))
      prompt = `User turn ${index}: load the annotated fixture for ${file} and extract the marked sections`
    } else {
      const content = virtualFileContent(virtualFiles, file, index - 1)
      const patch = makeEditPatch(rnd, file, index, content)
      oldString = patch.oldString
      newString = patch.newString
      prompt = `User turn ${index}: patch ${file} — apply block edit ${index}`
      const edits = virtualFiles.get(file) ?? []
      edits.push({ roundIndex: index, newString })
      virtualFiles.set(file, edits)
    }

    // Compact boundaries fire on every Nth round, except on the final round
    // (a boundary at the very end of the session carries no information).
    const boundaryEligible =
      config.compactEvery > 0 && index % config.compactEvery === 0
    const compactBoundary =
      boundaryEligible &&
      synthMessages + MESSAGES_PER_ROUND[kind] + 1 < config.messages

    plan.push({
      index,
      kind,
      prompt,
      ...(payloadSize !== undefined ? { payloadSize } : {}),
      file,
      ...(oldString !== undefined ? { oldString, newString } : {}),
      compactBoundary,
    })

    promptBytes += prompt.length * 2
    if (payloadSize !== undefined) {
      payloadBytes += payloadSize
    }
    if (oldString !== undefined && newString !== undefined) {
      editBytes += (oldString.length + newString.length) * 2
    }
    if (compactBoundary) {
      compactCount += 1
    }
    synthMessages += MESSAGES_PER_ROUND[kind] + (compactBoundary ? 1 : 0)
  }

  return {
    plan,
    stats: {
      rounds: plan.length,
      totalMessages: synthMessages,
      compactCount,
      promptBytes,
      payloadBytes,
      editBytes,
    },
    virtualFileAfter(roundIndex: number, file: string): string {
      return virtualFileContent(virtualFiles, file, roundIndex)
    },
  }
}
