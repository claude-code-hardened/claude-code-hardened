import { mock, describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, relative } from 'path'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

// Mock log/debug/bun:bundle to cut the heavy dependency chain
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

const { NotebookEditTool } = await import('../NotebookEditTool')
const { expandPath } = await import('src/utils/path.js')
const { getFileModificationTime } = await import('src/utils/file.js')

const NOTEBOOK = {
  cells: [
    {
      cell_type: 'code',
      id: 'cell-1',
      source: 'print(1)',
      metadata: {},
      execution_count: null,
      outputs: [],
    },
  ],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
}

type ReadEntry = {
  content: string
  timestamp: number
  offset?: number
  limit?: number
}

type ValidateResult = {
  result: boolean
  message?: string
  errorCode?: number
}

function makeCtx(readFileState?: Map<string, ReadEntry>): never {
  const emptyRules = {
    user: [],
    project: [],
    local: [],
    session: [],
    cliArg: [],
  }
  return {
    readFileState: readFileState ?? new Map(),
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Set(),
        alwaysAllowRules: { ...emptyRules },
        alwaysDenyRules: { ...emptyRules },
        alwaysAskRules: { ...emptyRules },
        isBypassPermissionsModeAvailable: false,
      },
    }),
  } as never
}

describe('NotebookEditTool path normalization', () => {
  let homeTmpDir: string
  let tmpDir: string
  let notebookFile: string
  let tildePath: string

  beforeAll(() => {
    // Real fixture under the user's home so the literal `~/...` notation
    // actually resolves through expandPath.
    homeTmpDir = mkdtempSync(join(homedir(), 'cch-nbtool-home-'))
    tmpDir = mkdtempSync(join(tmpdir(), 'cch-nbtool-test-'))
    notebookFile = join(homeTmpDir, 't.ipynb')
    writeFileSync(notebookFile, JSON.stringify(NOTEBOOK))
    tildePath = `~/${relative(homedir(), notebookFile)}`
  })

  afterAll(() => {
    rmSync(homeTmpDir, { recursive: true, force: true })
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('~ path matches the readFileState entry recorded at expanded path', async () => {
    // Read-before-edit state is keyed on the expanded path (what FileReadTool
    // recorded). Validation must resolve `~/...` to the same key instead of
    // treating it as `<cwd>/~/...`.
    const state = new Map<string, ReadEntry>()
    state.set(expandPath(tildePath), {
      content: JSON.stringify(NOTEBOOK),
      timestamp: getFileModificationTime(expandPath(tildePath)),
    })

    const result = (await NotebookEditTool.validateInput(
      { notebook_path: tildePath, new_source: 'print(2)', cell_id: 'cell-1' },
      makeCtx(state),
    )) as unknown as ValidateResult

    expect(result.result).toBe(true)
  })

  test('~ path to a file deleted after read reaches the ENOENT check', async () => {
    // With expandPath the seeded (expanded) key matches and the missing file
    // surfaces as the structured does-not-exist error. The old resolve()-based
    // lookup missed the read state and returned errorCode 9 ("not read").
    const missing = `~/cch-nbtool-gone-${process.pid}/x.ipynb`
    const state = new Map<string, ReadEntry>()
    state.set(expandPath(missing), {
      content: '',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const result = (await NotebookEditTool.validateInput(
      { notebook_path: missing, new_source: 'x', cell_id: 'cell-1' },
      makeCtx(state),
    )) as unknown as ValidateResult

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(1)
    expect(result.message).toBe('Notebook file does not exist.')
  })

  test('call() edits through the expanded path and re-keys readFileState', async () => {
    const state = new Map<string, ReadEntry>()
    state.set(expandPath(tildePath), {
      content: JSON.stringify(NOTEBOOK),
      timestamp: getFileModificationTime(expandPath(tildePath)),
    })

    const out = (await NotebookEditTool.call(
      { notebook_path: tildePath, new_source: 'print(2)', cell_id: 'cell-1' },
      { readFileState: state, updateFileHistoryState: async () => {} } as never,
      undefined as never,
      { uuid: 'parent-1' } as never,
    )) as unknown as { data: { error: string; notebook_path: string } }

    expect(out.data.error).toBe('')
    expect(out.data.notebook_path).toBe(expandPath(tildePath))
    const written = JSON.parse(readFileSync(notebookFile, 'utf8')) as {
      cells: Array<{ source: string }>
    }
    expect(written.cells[0]!.source).toBe('print(2)')
    expect(state.has(expandPath(tildePath))).toBe(true)
  })
})

describe('NotebookEditTool read-before-edit guards', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cch-nbtool-guard-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('existing notebook without a read returns must-read error (errorCode 9)', async () => {
    const file = join(tmpDir, 'unread.ipynb')
    writeFileSync(file, JSON.stringify(NOTEBOOK))

    const result = (await NotebookEditTool.validateInput(
      { notebook_path: file, new_source: 'x', cell_id: 'cell-1' },
      makeCtx(),
    )) as unknown as ValidateResult

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(9)
    expect(result.message).toBe(
      'File has not been read yet. Read it first before writing to it.',
    )
  })

  test('notebook deleted after read returns errorCode 1 instead of bare ENOENT', async () => {
    const file = join(tmpDir, 'vanish.ipynb')
    writeFileSync(file, JSON.stringify(NOTEBOOK))
    const state = new Map<string, ReadEntry>()
    state.set(file, {
      content: JSON.stringify(NOTEBOOK),
      timestamp: getFileModificationTime(file),
    })
    rmSync(file)

    const result = (await NotebookEditTool.validateInput(
      { notebook_path: file, new_source: 'x', cell_id: 'cell-1' },
      makeCtx(state),
    )) as unknown as ValidateResult

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(1)
    expect(result.message).toBe('Notebook file does not exist.')
  })
})
