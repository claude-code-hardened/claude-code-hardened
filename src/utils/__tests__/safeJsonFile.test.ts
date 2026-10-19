import { mock, describe, expect, test, afterEach } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  utimesSync,
  writeFileSync,
  openSync,
  closeSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logMock } from '../../../tests/mocks/log'

// Mock log.ts to cut the heavy dependency chain (log.ts → bootstrap/state.ts
// → analytics). safeJsonFile logs quarantines via logError.
mock.module('src/utils/log.ts', logMock)

const {
  quarantineCorruptFile,
  readJsonFileStrict,
  rejectCorruptJsonFile,
  StoreCorruptError,
  withStoreLock,
  writeJsonFileAtomic,
} = await import('../safeJsonFile')

let dir: string

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined as unknown as string
  }
})

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'safejson-'))
  return dir
}

describe('readJsonFileStrict — corruption refusal', () => {
  test('missing file → null (a genuinely fresh store)', () => {
    const path = join(freshDir(), 'store.json')
    expect(readJsonFileStrict(path)).toBeNull()
  })

  test('parseable file → the parsed value', () => {
    const path = join(freshDir(), 'store.json')
    writeJsonFileAtomic(path, { enabled: true })
    expect(readJsonFileStrict(path)).toEqual({ enabled: true })
  })

  test('corrupt file → quarantined (renamed aside) + StoreCorruptError, NOT overwritten as empty', () => {
    const path = join(freshDir(), 'store.json')
    writeFileSync(path, '{not json at all', 'utf8')
    let caught: unknown
    try {
      readJsonFileStrict(path)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StoreCorruptError)
    const err = caught as InstanceType<typeof StoreCorruptError>
    // The original is gone; the raw bytes live at the quarantine path.
    expect(existsSync(path)).toBe(false)
    expect(existsSync(err.backupPath)).toBe(true)
    expect(readFileSync(err.backupPath, 'utf8')).toBe('{not json at all')
    // Official quarantine suffix form (0004/module-006 deviceKeyStore):
    // .corrupt-<Date.now()>-<pid>-<3-byte-hex>
    expect(
      err.backupPath.match(/\.corrupt-\d+-\d+-[0-9a-f]{6}$/),
    ).not.toBeNull()
    // The store surfaces as an empty table afterwards (fresh store face).
    expect(readJsonFileStrict(path)).toBeNull()
  })

  test('rejectCorruptJsonFile quarantines shape-refused (but parseable) files', () => {
    const path = join(freshDir(), 'store.json')
    writeJsonFileAtomic(path, { enabled: 'yes' })
    expect(() => rejectCorruptJsonFile(path, 'bad shape')).toThrow(
      StoreCorruptError,
    )
    expect(existsSync(path)).toBe(false)
    expect(readJsonFileStrict(path)).toBeNull()
  })
})

describe('quarantineCorruptFile — rename semantics', () => {
  test('ENOENT is tolerated (a concurrent quarantine already moved the original)', () => {
    const path = join(freshDir(), 'store.json')
    const backup = quarantineCorruptFile(path)
    expect(backup).toContain('.corrupt-')
  })

  test('retention cap: more than 10 backups prunes the oldest', () => {
    const path = join(freshDir(), 'store.json')
    // Seed QUARANTINE_RETENTION_LIMIT + 3 backups with staggered mtimes.
    const total = 13
    for (let i = 0; i < total; i++) {
      const backup = `${path}.corrupt-1000-${i}-aabb${String(i).padStart(2, '0')}`
      writeFileSync(backup, `backup ${i}`, 'utf8')
      utimesSync(backup, i + 1, i + 1)
    }
    writeFileSync(path, 'broken', 'utf8')
    quarantineCorruptFile(path)
    const backups = readdirSync(dir).filter(name =>
      name.startsWith('store.json.corrupt-'),
    )
    expect(backups.length).toBeLessThanOrEqual(10)
    // The two OLDEST seeds were pruned.
    expect(backups).not.toContain('store.json.corrupt-1000-0-aabb00')
    expect(backups).not.toContain('store.json.corrupt-1000-1-aabb01')
    // The newest seed survived.
    expect(backups).toContain('store.json.corrupt-1000-12-aabb12')
  })
})

describe('withStoreLock — advisory read-modify-write serialization', () => {
  test('runs the critical section and releases the lock', () => {
    const path = join(freshDir(), 'store.json')
    const result = withStoreLock(path, () => 'ran')
    expect(result).toBe('ran')
    expect(existsSync(`${path}.lock`)).toBe(false)
  })

  test('a live (fresh) rival lock times out instead of racing it', () => {
    const path = join(freshDir(), 'store.json')
    const fd = openSync(`${path}.lock`, 'wx')
    closeSync(fd)
    expect(() =>
      withStoreLock(path, () => {}, { timeoutMs: 50, staleMs: 60_000 }),
    ).toThrow(/timed out acquiring store lock/)
    // The rival lock was not destroyed by the timed-out waiter.
    expect(existsSync(`${path}.lock`)).toBe(true)
  })

  test('a stale lock (older than staleMs) is seized', () => {
    const path = join(freshDir(), 'store.json')
    const lockPath = `${path}.lock`
    const fd = openSync(lockPath, 'wx')
    closeSync(fd)
    const longAgo = new Date(Date.now() - 120_000)
    utimesSync(lockPath, longAgo, longAgo)
    expect(
      withStoreLock(path, () => 'seized', {
        timeoutMs: 1_000,
        staleMs: 60_000,
      }),
    ).toBe('seized')
    expect(existsSync(lockPath)).toBe(false)
  })

  test('throws from the critical section still release the lock', () => {
    const path = join(freshDir(), 'store.json')
    expect(() =>
      withStoreLock(path, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(existsSync(`${path}.lock`)).toBe(false)
  })

  test('two child processes × fast loop → no lost update (create race)', async () => {
    const path = join(freshDir(), 'counter.json')
    // Child script: bumps the shared counter under the store lock.
    const childScript = join(dir, 'child.ts')
    writeFileSync(
      childScript,
      `
import { readJsonFileStrict, withStoreLock, writeJsonFileAtomic } from ${JSON.stringify('/root/xiaocongyu66-claude-code/src/utils/safeJsonFile.ts')}
const storePath = process.argv[2]
for (let i = 0; i < 10; i++) {
  withStoreLock(storePath, () => {
    const current = readJsonFileStrict(storePath) as { n?: number } | null
    const n = (current?.n ?? 0) + 1
    writeJsonFileAtomic(storePath, { n })
  })
}
`,
      'utf8',
    )
    const procs = [0, 1].map(() =>
      Bun.spawn([process.execPath, childScript, path]),
    )
    const codes = await Promise.all(procs.map(p => p.exited))
    expect(codes).toEqual([0, 0])
    const final = readJsonFileStrict(path) as { n?: number } | null
    // Without the lock, the read→write window would lose increments across
    // the two schedulers; the store must land at exactly 10+10.
    expect(final?.n).toBe(20)
  }, 60_000)

  test('lock file records the holder pid (advisory debug face)', () => {
    const path = join(freshDir(), 'store.json')
    withStoreLock(path, () => {
      // While held, the lock exists and names this process.
      const content = readFileSync(`${path}.lock`, 'utf8')
      expect(content).toContain(String(process.pid))
      expect(statSync(`${path}.lock`).isFile()).toBe(true)
    })
  })
})
