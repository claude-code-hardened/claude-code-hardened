/**
 * W4 (#55) — tests for the mTLS client-cert bundle bootstrap.
 * Uses a real generated RSA key (so createPublicKey validation runs) plus a
 * PEM-shaped cert stub (cert validation is a PEM-marker check).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { generateKeyPairSync } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../../tests/mocks/log.js'
import { debugMock } from '../../../../tests/mocks/debug.js'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

const {
  getClientCertBundle,
  hasClientCertConfigured,
  __resetClientCertBundleForTests,
} = await import('../mtls.js')

const ENV_KEYS = [
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
] as const

const CERT_STUB = [
  '-----BEGIN CERTIFICATE-----',
  'ZmFrZWNlcnQ=',
  '-----END CERTIFICATE-----',
  '',
].join('\n')

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const envSaves: Record<string, string | undefined> = {}
const tempDirs: string[] = []

function trackTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mtls-test-'))
  tempDirs.push(dir)
  return dir
}

function setEnvs(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
): void {
  for (const key of ENV_KEYS) {
    if (!(key in envSaves)) envSaves[key] = process.env[key]
  }
  for (const key of ENV_KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeEach(() => {
  __resetClientCertBundleForTests()
})

afterAll(() => {
  for (const [key, value] of Object.entries(envSaves)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('getClientCertBundle', () => {
  test('no env vars configured → clean no-op', () => {
    setEnvs({})
    expect(getClientCertBundle()).toBeNull()
    expect(hasClientCertConfigured()).toBe(false)
  })

  test('cert without key (or vice versa) is a no-op', () => {
    const dir = trackTempDir()
    const certPath = join(dir, 'cert.pem')
    writeFileSync(certPath, CERT_STUB)
    setEnvs({ CLAUDE_CODE_CLIENT_CERT: certPath })
    expect(getClientCertBundle()).toBeNull()
  })

  test('relative paths are rejected', () => {
    const dir = trackTempDir()
    setEnvs({
      CLAUDE_CODE_CLIENT_CERT: join(dir, 'cert.pem'),
      CLAUDE_CODE_CLIENT_KEY: 'relative/key.pem',
    })
    expect(getClientCertBundle()).toBeNull()
  })

  test('nonexistent files are rejected', () => {
    const dir = trackTempDir()
    setEnvs({
      CLAUDE_CODE_CLIENT_CERT: join(dir, 'cert.pem'),
      CLAUDE_CODE_CLIENT_KEY: join(dir, 'key.pem'),
    })
    expect(getClientCertBundle()).toBeNull()
  })

  test('valid PEM pair yields the bundle', () => {
    const dir = trackTempDir()
    const certPath = join(dir, 'cert.pem')
    const keyPath = join(dir, 'key.pem')
    writeFileSync(certPath, CERT_STUB)
    writeFileSync(keyPath, privateKey)
    setEnvs({
      CLAUDE_CODE_CLIENT_CERT: certPath,
      CLAUDE_CODE_CLIENT_KEY: keyPath,
    })
    const bundle = getClientCertBundle()
    expect(bundle).not.toBeNull()
    expect(bundle?.cert).toBe(CERT_STUB)
    expect(bundle?.key).toBe(privateKey)
    expect(bundle?.passphrase).toBeUndefined()
    expect(hasClientCertConfigured()).toBe(true)
  })

  test('file:// passphrase indirection is resolved', () => {
    const dir = trackTempDir()
    const certPath = join(dir, 'cert.pem')
    const keyPath = join(dir, 'key.pem')
    const passPath = join(dir, 'pass.txt')
    writeFileSync(certPath, CERT_STUB)
    writeFileSync(keyPath, privateKey)
    writeFileSync(passPath, 's3cret\n')
    setEnvs({
      CLAUDE_CODE_CLIENT_CERT: certPath,
      CLAUDE_CODE_CLIENT_KEY: keyPath,
      CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: `file://${passPath}`,
    })
    const bundle = getClientCertBundle()
    expect(bundle).not.toBeNull()
    expect(bundle?.passphrase).toBe('s3cret')
  })

  test('memoized until reset', () => {
    setEnvs({})
    expect(getClientCertBundle()).toBeNull()
    // Set env after the first computation: cache must hide it until reset.
    const dir = trackTempDir()
    const certPath = join(dir, 'cert.pem')
    const keyPath = join(dir, 'key.pem')
    mkdirSync(dir, { recursive: true })
    writeFileSync(certPath, CERT_STUB)
    writeFileSync(keyPath, privateKey)
    setEnvs({
      CLAUDE_CODE_CLIENT_CERT: certPath,
      CLAUDE_CODE_CLIENT_KEY: keyPath,
    })
    expect(getClientCertBundle()).toBeNull()
    __resetClientCertBundleForTests()
    expect(getClientCertBundle()).not.toBeNull()
  })
})
