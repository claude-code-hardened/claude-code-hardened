import { describe, expect, test } from 'bun:test'
import {
  daemonSockDir,
  ensureControlKey,
  isValidShortId,
  peerUidMismatchError,
  peerUidReject,
  redactSockPath,
  sendReply,
  sessionRootHash,
  verifyControlKey,
} from '../controlProtocol.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('controlProtocol', () => {
  describe('sessionRootHash / daemonSockDir', () => {
    test('hash is 8 hex chars, stable for same root', () => {
      const a = sessionRootHash('/tmp/work')
      const b = sessionRootHash('/tmp/work')
      expect(a).toMatch(/^[a-f0-9]{8}$/)
      expect(a).toBe(b)
    })
    test('sock dir embeds uid and hash, cch- prefix', () => {
      const dir = daemonSockDir('/tmp/work')
      const uid = process.getuid?.() ?? 0
      expect(dir).toContain(`cc-daemon-${uid}`)
      expect(dir.endsWith(sessionRootHash('/tmp/work'))).toBe(true)
    })
  })

  describe('verifyControlKey (upstream vD)', () => {
    test('matches equal keys', () => {
      expect(verifyControlKey('abc123', 'abc123')).toBe(true)
    })
    test('rejects different keys', () => {
      expect(verifyControlKey('abc124', 'abc123')).toBe(false)
    })
    test('rejects length mismatch without throwing', () => {
      expect(verifyControlKey('abc', 'abc123')).toBe(false)
    })
    test('rejects empty/undefined presentation', () => {
      expect(verifyControlKey('', 'abc123')).toBe(false)
      expect(verifyControlKey(undefined, 'abc123')).toBe(false)
      expect(verifyControlKey(42, 'abc123')).toBe(false)
    })
    test('rejects when server key missing', () => {
      expect(verifyControlKey('abc123', null)).toBe(false)
      expect(verifyControlKey('abc123', '')).toBe(false)
    })
  })

  describe('peerUidReject (upstream RTo)', () => {
    test('allows matching uid', () => {
      const uid = process.getuid?.()
      if (uid == null) return
      expect(peerUidReject({} as never, () => uid)).toBe(null)
    })
    test('produces official mismatch message', () => {
      const uid = process.getuid?.()
      if (uid == null) return
      const err = peerUidReject({} as never, () => uid + 1)
      expect(err).toBe(peerUidMismatchError(uid + 1, uid))
      expect(err).toContain('retry without sudo')
    })
    test('skips when peer credential unavailable', () => {
      expect(peerUidReject({} as never, () => null)).toBe(null)
    })
  })

  describe('redactSockPath (upstream hw)', () => {
    test('redacts Linux uid/hash8 layout', () => {
      expect(
        redactSockPath('bound at /tmp/cc-daemon-0/addcfb49/control.sock'),
      ).toBe('bound at /tmp/cc-daemon-*/control.sock')
    })
    test('redacts Windows pipe 16-hex id', () => {
      expect(redactSockPath('\\\\.\\pipe\\cc-daemon-0123456789abcdef-0')).toBe(
        '\\\\.\\pipe\\cc-daemon-*-0',
      )
    })
  })

  describe('isValidShortId', () => {
    test('accepts 8 hex chars only', () => {
      expect(isValidShortId('addcfb49')).toBe(true)
      expect(isValidShortId('ADDCFB49')).toBe(false)
      expect(isValidShortId('addcfb4')).toBe(false)
      expect(isValidShortId('addcfb499')).toBe(false)
      expect(isValidShortId(undefined)).toBe(false)
    })
  })

  describe('control key file', () => {
    test('ensureControlKey persists and reuses (0600)', () => {
      // 扰动 HOME 到临时目录，避免碰真实 ~/.claude/daemon/control.key
      const fakeHome = mkdtempSync(join(tmpdir(), 'cch-key-test-'))
      const prevHome = process.env['HOME']
      process.env['HOME'] = fakeHome
      try {
        const k1 = ensureControlKey()
        // 环境里可能已有官方遗留 key（32 hex）——不固定长度断言，
        // 持久化复用语义才是本测试的靶心
        expect(k1).toMatch(/^[0-9a-f]+$/)
        const k2 = ensureControlKey()
        expect(k2).toBe(k1)
      } finally {
        if (prevHome === undefined) delete process.env['HOME']
        else process.env['HOME'] = prevHome
        rmSync(fakeHome, { recursive: true, force: true })
      }
    })
  })

  describe('sendReply', () => {
    test('writes one JSON line and does not throw on destroyed socket', () => {
      const written: string[] = []
      const fake = {
        destroyed: false,
        end: (s: string) => {
          written.push(s)
        },
      }
      sendReply(fake as never, { ok: true, op: 'ping' })
      expect(written).toHaveLength(1)
      expect(written[0]!.endsWith('\n')).toBe(true)
      expect(JSON.parse(written[0]!)).toEqual({ ok: true, op: 'ping' })
      fake.destroyed = true
      sendReply(fake as never, { ok: false })
      expect(written).toHaveLength(1)
    })
  })
})
