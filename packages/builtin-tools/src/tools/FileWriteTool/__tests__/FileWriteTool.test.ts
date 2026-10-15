import { mock, describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

// Mock log/debug to cut the heavy dependency chain (bootstrap/state.ts SCC)
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

const { FileWriteTool } = await import('../FileWriteTool')
const { expandPath } = await import('src/utils/path.js')
const { getFileModificationTime } = await import('src/utils/file.js')

const FILE_NOT_READ_ERROR =
  'File has not been read yet. Read it first before writing to it.'

type ReadEntry = {
  content: string
  timestamp: number
  offset?: number
  limit?: number
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

type ValidateResult = {
  result: boolean
  message?: string
  errorCode?: number
}

describe('FileWriteTool read-before-edit', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cch-filewrite-test-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('existing file without a read returns structured must-read error', async () => {
    const file = join(dir, 'unread.ts')
    writeFileSync(file, 'old content')

    const result = (await FileWriteTool.validateInput(
      { file_path: file, content: 'new content' },
      makeCtx(),
    )) as unknown as ValidateResult

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
    expect(result.message).toBe(FILE_NOT_READ_ERROR)
  })

  test('freshly read file validates successfully', async () => {
    const file = join(dir, 'read.ts')
    writeFileSync(file, 'old content')
    const state = new Map<string, ReadEntry>()
    state.set(expandPath(file), {
      content: 'old content',
      timestamp: getFileModificationTime(file),
    })

    const result = (await FileWriteTool.validateInput(
      { file_path: file, content: 'new content' },
      makeCtx(state),
    )) as unknown as ValidateResult

    expect(result.result).toBe(true)
  })

  test('stale read still reports modified-since-read (errorCode 3)', async () => {
    const file = join(dir, 'stale.ts')
    writeFileSync(file, 'old content')
    const state = new Map<string, ReadEntry>()
    state.set(expandPath(file), {
      content: 'old content',
      timestamp: getFileModificationTime(file) - 1_000_000,
    })

    const result = (await FileWriteTool.validateInput(
      { file_path: file, content: 'new content' },
      makeCtx(state),
    )) as unknown as ValidateResult

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(3)
  })

  test('nonexistent file keeps the create-new-file path (no read required)', async () => {
    const file = join(dir, 'new', 'created.ts')

    const result = (await FileWriteTool.validateInput(
      { file_path: file, content: 'new content' },
      makeCtx(),
    )) as unknown as ValidateResult

    expect(result.result).toBe(true)
  })
})
