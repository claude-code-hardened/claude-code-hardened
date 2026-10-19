/**
 * W4 (#55) — tests for the security env read layer (src/utils/security/env.ts).
 * Pure env-file probing: every test saves/restores the touched keys.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../../tests/mocks/log.js'
import { debugMock } from '../../../../tests/mocks/debug.js'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

const {
  getBgAuthSnapshotPath,
  getGatewayToken,
  getSecureStorageConfigDir,
  hasGatewayTokenConfigured,
} = await import('../env.js')

const GATEWAY_KEYS = [
  'CLAUDE_CODE_GATEWAY_TOKEN',
  'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
] as const
const SNAP_KEY = ['CLAUDE_CODE_BG_AUTH_SNAPSHOT_PATH'] as const
const STORAGE_KEY = ['CLAUDE_SECURESTORAGE_CONFIG_DIR'] as const

const envSaves: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const [key, value] of Object.entries(envSaves)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const key of Object.keys(envSaves)) delete envSaves[key]
})

function withEnv(
  keys: readonly string[],
  values: Record<string, string | undefined>,
): void {
  for (const key of keys) {
    if (!(key in envSaves)) envSaves[key] = process.env[key]
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe('getGatewayToken', () => {
  test('returns null when nothing is configured', () => {
    withEnv(GATEWAY_KEYS, {})
    expect(getGatewayToken()).toBeNull()
    expect(hasGatewayTokenConfigured()).toBe(false)
  })

  test('returns the literal token when set', () => {
    withEnv(GATEWAY_KEYS, { CLAUDE_CODE_GATEWAY_TOKEN: 'tok_literal' })
    expect(getGatewayToken()).toBe('tok_literal')
    expect(hasGatewayTokenConfigured()).toBe(true)
  })

  test('FD content wins over the literal token', () => {
    const dir = trackTempDir('sec-env-test-')
    const file = join(dir, 'token.txt')
    writeFileSync(file, 'tok_from_fd\n')
    const fd = openSync(file, 'r')
    try {
      withEnv(GATEWAY_KEYS, {
        CLAUDE_CODE_GATEWAY_TOKEN: 'tok_literal',
        CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: String(fd),
      })
      expect(getGatewayToken()).toBe('tok_from_fd')
    } finally {
      closeSync(fd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('invalid FD values are ignored (literal still used)', () => {
    withEnv(GATEWAY_KEYS, {
      CLAUDE_CODE_GATEWAY_TOKEN: 'tok_literal',
      CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: 'not-a-number',
    })
    expect(getGatewayToken()).toBe('tok_literal')

    withEnv(GATEWAY_KEYS, {
      CLAUDE_CODE_GATEWAY_TOKEN: 'tok_literal',
      CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: '1',
    })
    expect(getGatewayToken()).toBe('tok_literal')
  })

  test('empty strings are treated as unset', () => {
    withEnv(GATEWAY_KEYS, { CLAUDE_CODE_GATEWAY_TOKEN: '' })
    expect(getGatewayToken()).toBeNull()
  })
})

describe('getBgAuthSnapshotPath', () => {
  test('returns null when unset or empty', () => {
    withEnv(SNAP_KEY, {})
    expect(getBgAuthSnapshotPath()).toBeNull()
    withEnv(SNAP_KEY, { CLAUDE_CODE_BG_AUTH_SNAPSHOT_PATH: '' })
    expect(getBgAuthSnapshotPath()).toBeNull()
  })

  test('rejects relative paths', () => {
    withEnv(SNAP_KEY, {
      CLAUDE_CODE_BG_AUTH_SNAPSHOT_PATH: 'relative/snapshot.json',
    })
    expect(getBgAuthSnapshotPath()).toBeNull()
  })

  test('accepts absolute paths', () => {
    const abs = join(tmpdir(), 'snapshot.json')
    withEnv(SNAP_KEY, { CLAUDE_CODE_BG_AUTH_SNAPSHOT_PATH: abs })
    expect(getBgAuthSnapshotPath()).toBe(abs)
  })
})

describe('getSecureStorageConfigDir', () => {
  test('returns null when unset or empty', () => {
    withEnv(STORAGE_KEY, {})
    expect(getSecureStorageConfigDir()).toBeNull()
    withEnv(STORAGE_KEY, { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' })
    expect(getSecureStorageConfigDir()).toBeNull()
  })

  test('rejects missing dirs and plain files', () => {
    withEnv(STORAGE_KEY, {
      CLAUDE_SECURESTORAGE_CONFIG_DIR: join(
        tmpdir(),
        'definitely-not-here-xyz',
      ),
    })
    expect(getSecureStorageConfigDir()).toBeNull()

    const file = writeTempFile('not-a-dir')
    withEnv(STORAGE_KEY, { CLAUDE_SECURESTORAGE_CONFIG_DIR: file })
    expect(getSecureStorageConfigDir()).toBeNull()
  })

  test('accepts an existing directory', () => {
    const dir = trackTempDir('sec-env-test-')
    withEnv(STORAGE_KEY, { CLAUDE_SECURESTORAGE_CONFIG_DIR: dir })
    expect(getSecureStorageConfigDir()).toBe(dir)
  })
})

const tempDirs: string[] = []

function trackTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeTempFile(content: string): string {
  const file = join(trackTempDir('sec-env-test-'), 'f')
  writeFileSync(file, content)
  return file
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})
