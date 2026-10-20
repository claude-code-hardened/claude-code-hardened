import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MAX_CACHED_ENTRIES = 200 // mirrors MAX_CACHED_SESSION_FILES in sessionStorage.ts

const {
  getSessionMessages,
  getSessionMessagesCache,
  clearSessionMessagesCache,
  setSessionFileForTesting,
  removeTranscriptMessage,
  recordTranscript,
  flushSessionStorage,
  resetProjectForTesting,
} = await import('../sessionStorage.js')

function asUuid(s: string): any {
  return s as unknown as any
}

let tempDir: string
let originalConfigDir: string | undefined

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `claude-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(tempDir, { recursive: true })
  // `getProjectsDir()` returns `${CLAUDE_CONFIG_DIR}/projects`, and
  // loadSessionFile reads from `${getProjectsDir()}/${sessionId}.jsonl`.
  // Pre-create the projects subdir so writeFileSync doesn't fail.
  mkdirSync(join(tempDir, 'projects'), { recursive: true })
  // Pin session-file lookups to a temp dir via CLAUDE_CONFIG_DIR.
  // Restoring in afterEach keeps tests hermetic.
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir
})

afterEach(() => {
  clearSessionMessagesCache()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function sessionFilePath(sessionId: string): string {
  // Mirror sessionStorage.ts's path computation:
  //   getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  // With CLAUDE_CONFIG_DIR=tempDir and getSessionProjectDir() returning
  // null in tests, files live at `${tempDir}/projects/${sessionId}.jsonl`.
  return join(tempDir, 'projects', `${sessionId}.jsonl`)
}

describe('getSessionMessagesCache', () => {
  test('returns the same Map instance across calls', () => {
    // Cache identity must be stable — `getLastSessionLog` uses
    // `getSessionMessagesCache()` directly to prime entries, so a
    // different instance each call would break that priming.
    expect(getSessionMessagesCache()).toBe(getSessionMessagesCache())
  })

  test('clearSessionMessagesCache empties a populated cache', async () => {
    const cache = getSessionMessagesCache()
    writeFileSync(sessionFilePath('id-1'), '')
    writeFileSync(sessionFilePath('id-2'), '')
    await getSessionMessages(asUuid('id-1'))
    await getSessionMessages(asUuid('id-2'))
    expect(cache.size).toBeGreaterThan(0)

    clearSessionMessagesCache()
    expect(cache.size).toBe(0)
  })

  test('clearSessionMessagesCache is a no-op on empty cache', () => {
    const cache = getSessionMessagesCache()
    expect(cache.size).toBe(0)
    clearSessionMessagesCache()
    expect(cache.size).toBe(0)
  })

  test('getSessionMessages dedups concurrent calls for the same sessionId', async () => {
    const cache = getSessionMessagesCache()
    const id = asUuid('same-id')
    writeFileSync(sessionFilePath('same-id'), '')
    const [a, b, c] = await Promise.all([
      getSessionMessages(id),
      getSessionMessages(id),
      getSessionMessages(id),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(cache.size).toBe(1)
  })
})

describe('getSessionMessages bounded cache (memory leak fix)', () => {
  test('cache size stays at MAX_CACHED_ENTRIES after many distinct sessionIds', async () => {
    // Bounded cache — calling getSessionMessages with N distinct
    // sessionIds must NOT grow the cache beyond MAX_CACHED_ENTRIES.
    // Pre-fix: lodash memoize grew unbounded. Post-fix: Map-based
    // cache evicts oldest entry when at capacity.
    const cache = getSessionMessagesCache()
    const total = MAX_CACHED_ENTRIES * 3 // 600 distinct sessionIds
    for (let i = 0; i < total; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
  })

  test('FIFO eviction: oldest entry is removed first', async () => {
    // Fill cache to MAX with sequential ids. The first inserted
    // (`oldest`) should be evicted on the (MAX+1)th insertion.
    const cache = getSessionMessagesCache()
    const oldestId = asUuid('id-0')
    writeFileSync(sessionFilePath('id-0'), '')
    await getSessionMessages(oldestId)
    for (let i = 1; i < MAX_CACHED_ENTRIES; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
    expect(cache.has(oldestId)).toBe(true)

    writeFileSync(sessionFilePath('id-overflow'), '')
    await getSessionMessages(asUuid('id-overflow'))
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
    expect(cache.has(oldestId)).toBe(false)
  })

  test('cleared cache can be refilled without leaking entries', async () => {
    const cache = getSessionMessagesCache()
    for (let i = 0; i < MAX_CACHED_ENTRIES; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)

    clearSessionMessagesCache()
    expect(cache.size).toBe(0)

    for (let i = 0; i < MAX_CACHED_ENTRIES + 5; i++) {
      writeFileSync(sessionFilePath(`refill-${i}`), '')
      await getSessionMessages(asUuid(`refill-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
  })
})

// Transcript write-queue tests (flush debounce + tombstone mutual exclusion).
// TEST_ENABLE_SESSION_PERSISTENCE lifts NodeEnv 'test' persistence skip so
// recordTranscript/removeTranscriptMessage actually enqueue and write.
describe('transcript write queue', () => {
  let persistenceEnv: string | undefined

  beforeEach(() => {
    persistenceEnv = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetProjectForTesting()
  })

  afterEach(() => {
    if (persistenceEnv === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = persistenceEnv
    }
    resetProjectForTesting()
  })

  function makeUserMessage(i: number): any {
    return {
      type: 'user' as const,
      uuid: asUuid(`flood-${i}`),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: `flood message ${i}` },
    }
  }

  test('no entries are dropped when the queue floods past the old 1000-entry cap', async () => {
    // Regression for the silent splice-drop: enqueueWrite used to discard
    // the oldest entries once >=1000 were queued (resolving their futures
    // without writing), losing transcript bytes with zero logging. Official
    // enqueueWrite (docs/reverse-284 full-source/_ALL.js) has no cap —
    // nothing may be dropped; backpressure is surfaced by a bounded
    // logError instead.
    const file = sessionFilePath('flood-queue')
    writeFileSync(file, '')
    setSessionFileForTesting(file)

    const total = 1200
    const messages = Array.from({ length: total }, (_, i) => makeUserMessage(i))
    await recordTranscript(messages)
    await flushSessionStorage()

    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0)
    expect(lines).toHaveLength(total)
    const uuids = new Set(
      lines.map(l => (JSON.parse(l) as { uuid: string }).uuid),
    )
    for (let i = 0; i < total; i++) {
      expect(uuids.has(`flood-${i}`)).toBe(true)
    }
  })

  test('tombstone excludes queued appends: remove + concurrent append never loses the appended entry', async () => {
    // Regression for the truncate-window race: appendEntry enqueues via the
    // 100ms debounced drain while removeMessageByUuid does a positional
    // truncate + re-append. The old implementation never drained the queue
    // first, so a debounced appendFile landing between truncate() and the
    // positional re-append of the trailing lines was silently cut.
    // Fixed behavior: removeMessageByUuid drains the queues BEFORE opening
    // its window and reinjects writes enqueued during the window AFTER the
    // tombstone completes — append order preserved, nothing lost.
    const file = sessionFilePath('tomb-race')
    const line = (uuid: string) =>
      JSON.stringify({
        type: 'user',
        uuid,
        message: { role: 'user', content: uuid },
      })
    writeFileSync(
      file,
      [line('aaa'), line('bbb'), line('ccc')].join('\n') + '\n',
    )
    setSessionFileForTesting(file)

    const appended = {
      type: 'user' as const,
      uuid: asUuid('appended-1'),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'appended during window' },
    }

    // Record the new message (queues it; drain timer arms for 100ms) and
    // race the tombstone for the last line immediately — the exact window
    // under review.
    await Promise.all([
      recordTranscript([appended]),
      removeTranscriptMessage(asUuid('ccc')),
    ])
    await flushSessionStorage()

    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0)
    const uuids = lines.map(
      l => (JSON.parse(l) as { uuid?: string }).uuid ?? '',
    )
    expect(uuids).not.toContain('ccc')
    // The appended entry was neither cut nor duplicated.
    expect(uuids.filter(u => u === 'appended-1')).toHaveLength(1)
    expect(uuids).toContain('aaa')
    expect(uuids).toContain('bbb')
  })
})
