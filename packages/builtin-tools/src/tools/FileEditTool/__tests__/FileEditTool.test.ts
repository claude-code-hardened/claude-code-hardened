import { mock, describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

// Mock log/debug to cut the heavy dependency chain (bootstrap/state.ts SCC)
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

const { FileEditTool } = await import('../FileEditTool')
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
  behavior?: string
  message?: string
  errorCode?: number
}

describe('FileEditTool read-before-edit', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cch-fileedit-test-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('existing file without a read returns structured must-read error', async () => {
    const file = join(dir, 'unread.ts')
    writeFileSync(file, 'hello world')

    const result = (await FileEditTool.validateInput(
      { file_path: file, old_string: 'hello', new_string: 'bye' },
      makeCtx(),
    )) as unknown as ValidateResult

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(6)
    expect(result.message).toBe(FILE_NOT_READ_ERROR)
  })

  test('freshly read file validates successfully', async () => {
    const file = join(dir, 'read.ts')
    writeFileSync(file, 'hello world')
    const state = new Map<string, ReadEntry>()
    state.set(expandPath(file), {
      content: 'hello world',
      timestamp: getFileModificationTime(file),
    })

    const result = (await FileEditTool.validateInput(
      { file_path: file, old_string: 'hello', new_string: 'bye' },
      makeCtx(state),
    )) as unknown as ValidateResult

    expect(result.result).toBe(true)
  })

  test('stale read still reports modified-since-read (errorCode 7)', async () => {
    const file = join(dir, 'stale.ts')
    writeFileSync(file, 'hello world')
    const state = new Map<string, ReadEntry>()
    // Read state holds the pre-modification content, so the
    // content-unchanged fallback cannot rescue the stale timestamp.
    state.set(expandPath(file), {
      content: 'outdated content',
      timestamp: getFileModificationTime(file) - 1_000_000,
    })

    const result = (await FileEditTool.validateInput(
      { file_path: file, old_string: 'hello', new_string: 'bye' },
      makeCtx(state),
    )) as unknown as ValidateResult

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(7)
  })
})

describe('FileEditTool UTF-16BE detection', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cch-fileedit-be-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('UTF-16BE (FE FF) file round-trips through validateInput', async () => {
    // BOM (FE FF) + 'hello world' encoded big-endian: encode as LE then swap.
    const beBytes = Buffer.from('\uFEFFhello world', 'utf16le').swap16()
    const file = join(dir, 'be.txt')
    writeFileSync(file, beBytes)

    // Round trip: decode with the same byte-swap the encoder used, seeding
    // the read state so the read-before-edit guard passes.
    const decoded = Buffer.from(beBytes).swap16().toString('utf16le')
    const state = new Map<string, ReadEntry>()
    state.set(expandPath(file), {
      content: decoded,
      timestamp: getFileModificationTime(file),
    })

    const result = (await FileEditTool.validateInput(
      { file_path: file, old_string: 'hello world', new_string: 'hi' },
      makeCtx(state),
    )) as unknown as ValidateResult

    // Before the FE FF branch, the file decoded as utf8 mojibake with NUL
    // padding, so findActualString('hello world') failed with errorCode 8.
    expect(result.result).toBe(true)
  })

  test('UTF-16BE CRLF content matches the normalized read state', async () => {
    // BE file whose decoded content ends up CRLF-normalized, exactly like
    // validateInput normalizes: mtime drifts past the recorded read, so the
    // content-compare fallback runs — decode + normalize must round-trip.
    const beBytes = Buffer.from('\uFEFFline1\r\nline2', 'utf16le').swap16()
    const file = join(dir, 'be-crlf.txt')
    writeFileSync(file, beBytes)

    const state = new Map<string, ReadEntry>()
    state.set(expandPath(file), {
      content: '\uFEFFline1\nline2',
      timestamp: getFileModificationTime(file) - 1_000_000,
    })

    const result = (await FileEditTool.validateInput(
      { file_path: file, old_string: 'line2', new_string: 'line3' },
      makeCtx(state),
    )) as unknown as ValidateResult

    expect(result.result).toBe(true)
  })
})
