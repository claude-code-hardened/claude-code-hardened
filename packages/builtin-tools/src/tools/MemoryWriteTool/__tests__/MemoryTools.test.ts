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

describe('MemoryTools (memory_write / memory_list / memory_read)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-tools-test-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
    delete process.env['CLAUDE_PROJECT_DIR']
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['CLAUDE_CONFIG_DIR']
    delete process.env['CLAUDE_PROJECT_DIR']
  })

  describe('memory_write', () => {
    test('writes markdown + frontmatter to the shared local-memory root', async () => {
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const result = await MemoryWriteTool.call({
        store: 'notes',
        path: 'retry-logic.md',
        content: 'Payments retry twice, then park.',
        name: 'payments-retry-logic',
        description: 'How payment retries are scheduled',
        type: 'project',
      })
      expect(result.data.error).toBeUndefined()
      expect(result.data.created).toBe(true)
      expect(result.data.store).toBe('notes')
      expect(result.data.path).toBe('retry-logic.md')

      const target = join(tmpDir, 'local-memory', 'notes', 'retry-logic.md')
      expect(existsSync(target)).toBe(true)
      const raw = readFileSync(target, 'utf8')
      expect(raw.startsWith('---\n')).toBe(true)
      expect(raw).toContain('name: payments-retry-logic')
      expect(raw).toContain('description: How payment retries are scheduled')
      expect(raw).toContain('type: project')
      expect(raw).toContain('Payments retry twice, then park.')
    })

    test('same path overwrite wins and reports created:false', async () => {
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const base = { store: 'notes', path: 'over.md' }
      await MemoryWriteTool.call({ ...base, content: 'first version' })
      const second = await MemoryWriteTool.call({
        ...base,
        content: 'second version',
      })
      expect(second.data.created).toBe(false)
      const target = join(tmpDir, 'local-memory', 'notes', 'over.md')
      expect(readFileSync(target, 'utf8')).toContain('second version')
      expect(readFileSync(target, 'utf8')).not.toContain('first version')
    })

    test('rejects traversal and absolute paths, writes nothing outside root', async () => {
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      for (const path of ['../evil.md', '/tmp/evil.md', 'sub/../../x.md']) {
        const result = await MemoryWriteTool.call({
          store: 'notes',
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
      const storeDir = join(tmpDir, 'local-memory', 'notes')
      mkdirSync(storeDir, { recursive: true })
      symlinkSync(outside, join(storeDir, 'sub'))

      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const result = await MemoryWriteTool.call({
        store: 'notes',
        path: 'sub/escape.md',
        content: 'escape',
      })
      expect(result.data.error).toMatch(/outside/i)
      expect(existsSync(join(outside, 'escape.md'))).toBe(false)
    })

    test('defaults store to a project-scoped name', async () => {
      const projectDir = join(tmpDir, 'my project')
      mkdirSync(projectDir, { recursive: true })
      process.env['CLAUDE_PROJECT_DIR'] = projectDir

      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const result = await MemoryWriteTool.call({
        path: 'doc.md',
        content: 'project scoped',
      })
      expect(result.data.error).toBeUndefined()
      expect(result.data.store).toBe('project-my_project')
      expect(
        existsSync(
          join(tmpDir, 'local-memory', 'project-my_project', 'doc.md'),
        ),
      ).toBe(true)
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

    test('list returns empty docs for a missing store', async () => {
      const { MemoryListTool } = await import('../MemoryListTool.js')
      const result = await MemoryListTool.call({ store: 'ghost' })
      expect(result.data.docs).toEqual([])
      expect(result.data.error).toBeUndefined()
    })

    test('list, read and write agree on paths (round-trip)', async () => {
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      const { MemoryListTool } = await import('../MemoryListTool.js')
      const { MemoryReadTool } = await import('../MemoryReadTool.js')

      await MemoryWriteTool.call({
        store: 'notes',
        path: 'r.md',
        content: 'read me',
        type: 'user',
      })
      const listed = await MemoryListTool.call({ store: 'notes' })
      const listedPath = (listed.data.docs ?? [])[0]?.path
      expect(listedPath).toBe('r.md')

      const read = await MemoryReadTool.call({
        store: 'notes',
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
    test('docs written by memory_write are fetchable via LocalMemoryRecall', async () => {
      const { MemoryWriteTool } = await import('../MemoryWriteTool.js')
      await MemoryWriteTool.call({
        store: 'notes',
        path: 'hello.md',
        content: 'recallable body text',
        type: 'user',
      })

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
