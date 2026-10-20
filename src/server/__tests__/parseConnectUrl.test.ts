import { describe, expect, test } from 'bun:test'

import { parseConnectUrl } from '../parseConnectUrl.js'

describe('parseConnectUrl', () => {
  test('parses cc://host:port without a token', () => {
    const parsed = parseConnectUrl('cc://127.0.0.1:45678')
    expect(parsed.serverUrl).toBe('http://127.0.0.1:45678')
    expect(parsed.authToken).toBe('')
    expect(parsed.isUnix).toBe(false)
  })

  test('extracts sk-ant-cc- token from the path', () => {
    const parsed = parseConnectUrl('cc://localhost:3000/sk-ant-cc-abc123')
    expect(parsed.serverUrl).toBe('http://localhost:3000')
    expect(parsed.authToken).toBe('sk-ant-cc-abc123')
  })

  test('extracts sk-ant-si- token from userinfo', () => {
    const parsed = parseConnectUrl('cc://sk-ant-si-xyz@10.0.0.5:8082')
    expect(parsed.serverUrl).toBe('http://10.0.0.5:8082')
    expect(parsed.authToken).toBe('sk-ant-si-xyz')
  })

  test('parses cc+unix:// into a unix transport descriptor', () => {
    const parsed = parseConnectUrl('cc+unix:///tmp/claude-server.sock')
    expect(parsed.isUnix).toBe(true)
    expect(parsed.unix).toBe('/tmp/claude-server.sock')
    expect(parsed.authToken).toBe('')
  })

  test('rejects bare userinfo and unknown schemes', () => {
    expect(() => parseConnectUrl('cc://not-a-token@host:1')).toThrow()
    expect(() => parseConnectUrl('http://host:1')).toThrow()
    expect(() => parseConnectUrl('cc://')).toThrow()
    expect(() => parseConnectUrl('cc+unix://')).toThrow()
  })

  test('keeps the canonical bracketed IPv6 authority', () => {
    const parsed = parseConnectUrl('cc://sk-ant-cc-t@[::1]:8080')
    expect(parsed.serverUrl).toBe('http://[::1]:8080')
    expect(parsed.authToken).toBe('sk-ant-cc-t')
  })

  test('brackets an unbracketed bare IPv6 literal', () => {
    const parsed = parseConnectUrl('cc://::1')
    expect(parsed.serverUrl).toBe('http://[::1]')
  })

  test('splits the trailing port off an unbracketed IPv6 literal', () => {
    const parsed = parseConnectUrl('cc://::1:8080')
    expect(parsed.serverUrl).toBe('http://[::1]:8080')
  })

  test('does not mistake a short IPv6 suffix for a port', () => {
    // "::80" is an IPv6 address (single colon before the tail) — brackets whole.
    expect(parseConnectUrl('cc://::80').serverUrl).toBe('http://[::80]')
    // Plain host:port must be untouched.
    expect(parseConnectUrl('cc://example.com:8080').serverUrl).toBe(
      'http://example.com:8080',
    )
  })
})
