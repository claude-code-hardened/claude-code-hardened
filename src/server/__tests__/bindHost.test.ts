import { describe, expect, test } from 'bun:test'

import { urlHostFor } from '../bindHost.js'
import { printBanner } from '../serverBanner.js'
import type { ServerConfig } from '../types.js'

describe('urlHostFor', () => {
  test('brackets raw IPv6 literals', () => {
    expect(urlHostFor('::1')).toBe('[::1]')
    expect(urlHostFor('fe80::1')).toBe('[fe80::1]')
  })

  test('maps wildcard binds to loopback', () => {
    expect(urlHostFor('0.0.0.0')).toBe('127.0.0.1')
    expect(urlHostFor('::')).toBe('127.0.0.1')
    expect(urlHostFor(undefined)).toBe('127.0.0.1')
    expect(urlHostFor('')).toBe('127.0.0.1')
  })

  test('leaves plain and already-bracketed hosts untouched', () => {
    expect(urlHostFor('127.0.0.1')).toBe('127.0.0.1')
    expect(urlHostFor('example.com')).toBe('example.com')
    expect(urlHostFor('[::1]')).toBe('[::1]')
  })

  test('is safe to apply twice', () => {
    expect(urlHostFor(urlHostFor('::1'))).toBe('[::1]')
  })
})

describe('printBanner', () => {
  const config = (host: string): ServerConfig => ({
    port: 3000,
    host,
    authToken: 'sk-ant-cc-test',
  })

  function captureBanner(config: ServerConfig): string {
    const chunks: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      printBanner(config, 'sk-ant-cc-test', 3000)
    } finally {
      process.stderr.write = original
    }
    return chunks.join('')
  }

  test('brackets IPv6 in both the http and cc:// URLs', () => {
    const out = captureBanner(config('::1'))
    expect(out).toContain('http://[::1]:3000')
    expect(out).toContain('cc://sk-ant-cc-test@[::1]:3000')
    expect(out).not.toContain('http://::1:3000')
  })

  test('maps the wildcard bind to loopback URLs', () => {
    const out = captureBanner(config('0.0.0.0'))
    expect(out).toContain('http://127.0.0.1:3000')
    expect(out).toContain('cc://sk-ant-cc-test@127.0.0.1:3000')
  })
})
