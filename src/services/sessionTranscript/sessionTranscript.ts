// KAIROS session transcript segment persistence.
//
// Compaction (src/services/compact/compact.ts) and the date-change
// attachment (src/utils/attachments.ts) hand us the pre-compaction /
// pre-midnight messages so that the /dream skill (1–5am local) can find
// yesterday's work even after the main transcript was compacted away.
//
// Official anchor (docs/reverse-284 — full-source/_ALL.js:36847-36848):
// the /share (feedback_transcript_share) chain builds the
// `POST /api/claude_code_shared_session_transcripts` body as
// `{ trigger, version, platform, commitSha, transcript (string[]),
//   subagentTranscripts?, lastApiRequest?, rawTranscriptJsonl }` and the
// endpoint replies with `{ transcript_id }`. The request-scoped fields
// (`subagentTranscripts` / `lastApiRequest` / `rawTranscriptJsonl`) have no
// per-line equivalent, so SegmentLine below keeps the recoverable envelope
// (trigger / version / platform / commitSha / transcript) plus a documented
// local superset (ts / sessionId / date). Inferred here: the trigger VALUES
// ('compact' | 'date_change' — upstream values were not recoverable), the
// date bucketing, and the decision to store the raw Message instead of
// pre-serialized lines (needed so /dream can re-render full structure).
import { mkdir, appendFile } from 'fs/promises'
import { join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import type { Message } from '../../types/message.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getProjectDir } from '../../utils/sessionStorage.js'

type SegmentTrigger = 'compact' | 'date_change'

// One JSONL line per message — name-aligned superset of the official POST
// body (see module docblock for the recovered /share envelope).
type SegmentLine = {
  /** Official body field: what triggered the flush. Value set inferred. */
  trigger: SegmentTrigger
  /** Official body field: CLI version (MACRO.VERSION). */
  version: string
  /** Official body field: build platform. */
  platform: string
  /** Official body field: `commitSha` of the running build (`Me || null`
   * upstream). Always null locally — the value is a build-time constant not
   * recoverable at runtime in this tree. */
  commitSha: string | null
  /** Official body field: transcript payload. The official body packs a
   * string[] of serialized lines; KAIROS stores the raw Message so the
   * /dream skill can re-render full structure (inferred superset). */
  transcript: Message
  /** Local addition: segment write time (ISO-8601). */
  ts: string
  /** Local addition: owning session id. */
  sessionId: string
  /** Local addition: bucket date (YYYY-MM-DD) the message landed in. */
  date: string
}

function localISODate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Directory for per-day segment files — aligned with the session-storage
 * layout (`<projects>/<sanitized-cwd>/…`, same project dir as the main
 * `<sessionId>.jsonl` transcript) but nested under `session-transcripts/`
 * so resume pickers that glob `<projectDir>/*.jsonl` don't mistake
 * segments for resumable sessions.
 */
export function getSessionSegmentDir(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, 'session-transcripts')
}

/** Per-day bucket file for a session: `<date>-<sessionId>.jsonl`. */
export function getSegmentFilePath(
  date: string,
  sessionId = getSessionId(),
): string {
  return join(getSessionSegmentDir(), `${date}-${sessionId}.jsonl`)
}

/** Bucket date for a message: its timestamp's local date, else fallback. */
function bucketDateFor(message: Message, fallbackDate: string): string {
  const timestamp = (message as { timestamp?: unknown }).timestamp
  if (typeof timestamp === 'string') {
    const parsed = new Date(timestamp)
    if (!Number.isNaN(parsed.getTime())) {
      return localISODate(parsed)
    }
  }
  return fallbackDate
}

/**
 * Append the given messages to the per-day segment JSONL files, bucketed
 * by message timestamp so a multi-day flush lands one line per day file.
 * Fire-and-forget contract: never throws. Messages that fail to serialize
 * are logged via logError (production-visible) and skipped — the remaining
 * messages in the batch still land (one unserializable Message used to
 * reject the whole batch). Write failures are surfaced via logError too.
 */
export async function writeSessionTranscriptSegment(
  messages: Message[],
  kind: SegmentTrigger = 'compact',
): Promise<void> {
  const sessionId = getSessionId()
  const today = localISODate()
  const linesByDate = new Map<string, string[]>()
  for (const message of messages) {
    const date = bucketDateFor(message, today)
    const line: SegmentLine = {
      trigger: kind,
      version: typeof MACRO !== 'undefined' ? MACRO.VERSION : '',
      platform: process.platform,
      commitSha: null,
      transcript: message,
      ts: new Date().toISOString(),
      sessionId,
      date,
    }
    let serialized: string
    try {
      // Per-message try: a single unserializable entry (circular ref,
      // BigInt, ...) must not reject the whole batch. Previously the
      // JSON.stringify ran outside any try, so one bad Message rejected
      // the promise — and compact.ts's `void` call had no .catch, turning
      // it into an unhandled rejection while every other message in the
      // batch was lost.
      serialized = `${JSON.stringify(line)}\n`
    } catch (error) {
      logError(
        new Error(
          `[sessionTranscript] failed to serialize message (uuid: ${(message as { uuid?: unknown }).uuid ?? 'unknown'}) — skipping it, writing the rest of the batch`,
          { cause: toError(error) },
        ),
      )
      continue
    }
    const lines = linesByDate.get(date) ?? []
    lines.push(serialized)
    linesByDate.set(date, lines)
  }
  if (linesByDate.size === 0) {
    return
  }
  try {
    const dir = getSessionSegmentDir()
    await mkdir(dir, { recursive: true })
    for (const [date, lines] of linesByDate) {
      await appendFile(
        join(dir, `${date}-${sessionId}.jsonl`),
        lines.join(''),
        'utf8',
      )
    }
  } catch (error) {
    logError(
      new Error('[sessionTranscript] segment write failed', {
        cause: toError(error),
      }),
    )
  }
}

/**
 * Date-change flush (past midnight): re-home messages predating
 * `currentDate` into their per-day buckets. Bucketing happens inside
 * writeSessionTranscriptSegment, so a multi-day gap writes each day file
 * correctly; messages without timestamps bucket under the flush-time
 * local date (== `currentDate` at the moment attachments fires this).
 * `currentDate` is kept for signature parity with the caller.
 */
export function flushOnDateChange(
  messages: Message[],
  _currentDate: string,
): void {
  void writeSessionTranscriptSegment(messages, 'date_change').catch(error => {
    logError(
      new Error('[sessionTranscript] date-change flush failed', {
        cause: toError(error),
      }),
    )
  })
}
