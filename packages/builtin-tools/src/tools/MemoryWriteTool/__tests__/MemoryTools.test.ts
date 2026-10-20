import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Fixture: a temp CLAUDE_CONFIG_DIR gives the trio a throwaway
// $CONFIG_DIR/local-memory root — the SAME root LocalMemoryRecall reads from,
// so the interop test below exercises real same-root read/write.
// CLAUDE_PROJECT_DIR pins the writable default store; the store allowlist
// (official connected-store semantics) derives availability from this root.

describe('MemoryTools (memory_write / memory_list / memory_read)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-tools-test-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
    const projectDir = join(tmpDir, 'proj')
    mkdirSync(projectDir, { recursive: true })
    process.env['CLAUDE_PROJECT_DIR'] = projectDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['CLAUDE_CONFIG_DIR']
    delete process.env['CLAUDE_PROJECT_DIR']
  })

  /** The project-scoped default store the tools treat as writable. */
  const defaultStore = 'project-proj'

  describe('memory_write', () => {
    test('writes markdown + frontmatter to the default project store', async () => {
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const result = await MemoryWriteTool.call({
        path: 'retry-logic.md',
        content: 'Payments retry twice, then park.',
        name: 'payments-retry-logic',
        description: 'How payment retries are scheduled',
        type: 'project',
      })
      expect(result.data.error).toBeUndefined()
      expect(result.data.created).toBe(true)
      expect(result.data.store).toBe(defaultStore)
      expect(result.data.path).toBe('retry-logic.md')

      const target = join(
        tmpDir,
        'local-memory',
        defaultStore,
        'retry-logic.md',
      )
      expect(existsSync(target)).toBe(true)
      const raw = readFileSync(target, 'utf8')
      expect(raw.startsWith('---\n')).toBe(true)
      expect(raw).toContain('name: payments-retry-logic')
      expect(raw).toContain('description: How payment retries are scheduled')
      expect(raw).toContain('type: project')
      expect(raw).toContain('Payments retry twice, then park.')
      // Cold transform of the src/Tool.js import chain lands inside the
      // FIRST test of the file (dynamic import is in-test); a cold bun cache
      // pushes it past the 5s default (seen in CI sandbox). Later tests are
      // warm and default-fast.
    }, 30_000)

    test('explicit default-store name is equivalent to omitting store', async () => {
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const result = await MemoryWriteTool.call({
        store: defaultStore,
        path: 'explicit.md',
        content: 'explicit store',
      })
      expect(result.data.error).toBeUndefined()
      expect(result.data.store).toBe(defaultStore)
      expect(
        existsSync(join(tmpDir, 'local-memory', defaultStore, 'explicit.md')),
      ).toBe(true)
    })

    test('refuses stores outside the session allowlist (official unknown_store)', async () => {
      // Official `Eit` (reverse-284 _ALL.js:5230): a store id not in the
      // session's connected set is refused — the model can no longer invent
      // arbitrary (e.g. cross-project) store names.
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const result = await MemoryWriteTool.call({
        store: 'invented-store',
        path: 'x.md',
        content: 'nope',
      })
      expect(result.data.error).toContain('invented-store')
      expect(result.data.error).toContain('available in this session')
      expect(result.data.error).toContain(defaultStore) // lists available stores
    })

    test('refuses writes to existing non-default stores (official read_only gate)', async () => {
      // Official writable gate: `if (n && !a.writable)` → refused/read_only.
      // CCH keeps write (documented extension beyond official) for the
      // current project store only — 共享 / 其他 project-* store 拒写.
      const sharedDir = join(tmpDir, 'local-memory', 'shared-store')
      mkdirSync(sharedDir, { recursive: true })
      const otherProjectDir = join(tmpDir, 'local-memory', 'project-other')
      mkdirSync(otherProjectDir, { recursive: true })

      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      for (const store of ['shared-store', 'project-other']) {
        const result = await MemoryWriteTool.call({
          store,
          path: 'x.md',
          content: 'nope',
        })
        expect(result.data.error).toContain('read-only in this session')
      }
      expect(existsSync(join(sharedDir, 'x.md'))).toBe(false)
    })

    test('enforces the official 102400-byte content cap', async () => {
      // Official cap: `d5e=102400` → `RIt` used by both the write refusal
      // (`Pe`: byteLength > at → refused) and the server mapping
      // "content must be at most 102400 bytes". Old CCH value (1 MiB) was a
      // multiStore constant, not the official memory-tool face.
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const result = await MemoryWriteTool.call({
        path: 'big.md',
        content: 'x'.repeat(102_401),
      })
      expect(result.data.error).toContain('max 102400 bytes')
      const ok = await MemoryWriteTool.call({
        path: 'fits.md',
        content: 'x'.repeat(102_400),
      })
      expect(ok.data.error).toBeUndefined()
    })

    test('same path overwrite wins and reports created:false', async () => {
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const base = { path: 'over.md' }
      await MemoryWriteTool.call({ ...base, content: 'first version' })
      const second = await MemoryWriteTool.call({
        ...base,
        content: 'second version',
      })
      expect(second.data.created).toBe(false)
      const target = join(tmpDir, 'local-memory', defaultStore, 'over.md')
      expect(readFileSync(target, 'utf8')).toContain('second version')
      expect(readFileSync(target, 'utf8')).not.toContain('first version')
    })

    test('rejects traversal and absolute paths, writes nothing outside root', async () => {
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      for (const path of ['../evil.md', '/tmp/evil.md', 'sub/../../x.md']) {
        const result = await MemoryWriteTool.call({
          path,
          content: 'nope',
        })
        expect(result.data.error).toBeTruthy()
      }
      expect(existsSync(join(tmpDir, 'evil.md'))).toBe(false)
      expect(existsSync(join(tmpDir, 'tmp', 'evil.md'))).toBe(false)
      expect(existsSync(join(tmpDir, 'x.md'))).toBe(false)
    })

    test('rejects writes reaching outside the root through symlinked dirs', async () => {
      const outside = join(tmpDir, 'outside')
      mkdirSync(outside, { recursive: true })
      // The writable default store gets pre-created so the symlink simulates
      // a tampered store dir (the store itself is on the allowlist).
      const storeDir = join(tmpDir, 'local-memory', defaultStore)
      mkdirSync(storeDir, { recursive: true })
      symlinkSync(outside, join(storeDir, 'sub'))

      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const result = await MemoryWriteTool.call({
        path: 'sub/escape.md',
        content: 'escape',
      })
      expect(result.data.error).toMatch(/outside/i)
      expect(existsSync(join(outside, 'escape.md'))).toBe(false)
    })

    test('checkPermissions denies off-whitelist stores and asks for the project store', async () => {
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      mkdirSync(join(tmpDir, 'local-memory', 'shared-store'), {
        recursive: true,
      })

      const unknown = await MemoryWriteTool.checkPermissions({
        store: 'invented-store',
        path: 'x.md',
        content: 'y',
      } as never)
      expect(unknown).toMatchObject({ behavior: 'deny' })
      expect((unknown as { message: string }).message).toContain(
        'available in this session',
      )

      const readOnly = await MemoryWriteTool.checkPermissions({
        store: 'shared-store',
        path: 'x.md',
        content: 'y',
      } as never)
      expect(readOnly).toMatchObject({ behavior: 'deny' })
      expect((readOnly as { message: string }).message).toContain('read-only')

      const projectStore = await MemoryWriteTool.checkPermissions({
        path: 'x.md',
        content: 'y',
      } as never)
      // CCH retains memory_write (extension beyond the official read-only
      // stance) — gated behind the canUseTool ask surface.
      expect(projectStore).toMatchObject({ behavior: 'ask' })
    })
  })

  describe('memory_list / memory_read', () => {
    test('list returns frontmatter name/description/type for every doc', async () => {
      const storeDir = join(tmpDir, 'local-memory', 'notes')
      mkdirSync(storeDir, { recursive: true })
      writeFileSync(
        join(storeDir, 'a.md'),
        [
          '---',
          'name: Doc A',
          'description: first doc',
          'type: user',
          '---',
          '',
          'body a',
          '',
        ].join('\n'),
      )
      mkdirSync(join(storeDir, 'sub'), { recursive: true })
      // frontmatter 不带 name / description / type → 断言（下方）默认
      // name = stem，type = general，且 description 字段不输出。
      writeFileSync(
        join(storeDir, 'sub', 'b.md'),
        ['---', 'tags: memory-test', '---', '', 'body b', ''].join('\n'),
      )
      // Junk that must be ignored: dotfile + non-md.
      writeFileSync(join(storeDir, '.hidden.md'), 'junk')
      writeFileSync(join(storeDir, 'notes.txt'), 'junk')

      const { MemoryListTool } = await import('../MemoryListTool.js')
      const result = await MemoryListTool.call({ store: 'notes' })
      expect(result.data.error).toBeUndefined()
      const docs = result.data.docs ?? []
      expect(docs.map(d => d.path)).toEqual(['a.md', 'sub/b.md'])
      expect(docs[0]).toEqual({
        path: 'a.md',
        name: 'Doc A',
        type: 'user',
        description: 'first doc',
      })
      // Defaults: name = stem, type = general.
      expect(docs[1]).toEqual({
        path: 'sub/b.md',
        name: 'b',
        type: 'general',
      })
    })

    test('refuses stores outside the session allowlist', async () => {
      const { MemoryListTool } = await import('../MemoryListTool.js')
      const result = await MemoryListTool.call({ store: 'ghost' })
      expect(result.data.error).toContain('available in this session')

      const read = await import('../MemoryReadTool.js')
      const readResult = await read.MemoryReadTool.call({
        store: 'ghost',
        path: 'x.md',
      })
      expect(readResult.data.error).toContain('available in this session')
      // checkPermissions 面同口径（deny）。
      const decision = await read.MemoryReadTool.checkPermissions({
        store: 'ghost',
        path: 'x.md',
      } as never)
      expect(decision).toMatchObject({ behavior: 'deny' })
    })

    test('list, read and write agree on paths (round-trip)', async () => {
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const { MemoryListTool } = await import('../MemoryListTool.js')
      const { MemoryReadTool } = await import('../MemoryReadTool.js')

      await MemoryWriteTool.call({
        path: 'r.md',
        content: 'read me',
        type: 'user',
      })
      const listed = await MemoryListTool.call({})
      const listedPath = (listed.data.docs ?? [])[0]?.path
      expect(listedPath).toBe('r.md')

      const read = await MemoryReadTool.call({
        path: listedPath ?? 'r.md',
      })
      expect(read.data.error).toBeUndefined()
      expect(read.data.content).toContain('read me')
      expect(read.data.content).toContain('type: user')
      expect(read.data.truncated).toBeUndefined()
    })

    test('read errors for missing docs', async () => {
      const storeDir = join(tmpDir, 'local-memory', 'notes')
      mkdirSync(storeDir, { recursive: true })
      const { MemoryReadTool } = await import('../MemoryReadTool.js')
      const result = await MemoryReadTool.call({
        store: 'notes',
        path: 'missing.md',
      })
      expect(result.data.error).toMatch(/not found/i)
    })
  })

  describe('same-root interop with LocalMemoryRecall', () => {
    test('docs shipped by other writers are fetchable via LocalMemoryRecall', async () => {
      // 跨面互操作保持：同一 local-memory 根里由其他写入方（multiStore /
      // 用户）落盘的文档对 memory 三件套可见（read/list 的 allowlist =
      // 已存在 store 集），且 LocalMemoryRecall.fetch 可直取。
      const storeDir = join(tmpDir, 'local-memory', 'notes')
      mkdirSync(storeDir, { recursive: true })
      writeFileSync(
        join(storeDir, 'hello.md'),
        [
          '---',
          'name: hello',
          'type: user',
          '---',
          '',
          'recallable body text',
          '',
        ].join('\n'),
      )
      // memory_read 从同一根按允许列表读取。
      const { MemoryReadTool } = await import('../MemoryReadTool.js')
      const read = await MemoryReadTool.call({
        store: 'notes',
        path: 'hello.md',
      })
      expect(read.data.error).toBeUndefined()
      expect(read.data.content).toContain('recallable body text')

      const { LocalMemoryRecallTool } = await import(
        '../../LocalMemoryRecallTool/LocalMemoryRecallTool.js'
      )
      const result = await LocalMemoryRecallTool.call(
        { action: 'fetch', store: 'notes', key: 'hello', preview_only: true },
        { toolUseId: 't10b' } as never,
      )
      expect(result.data.error).toBeUndefined()
      // Recall wraps the same file (frontmatter + body) from the shared root.
      expect(result.data.value).toContain('recallable body text')
      expect(result.data.value).toContain('type: user')
    })
  })
})
