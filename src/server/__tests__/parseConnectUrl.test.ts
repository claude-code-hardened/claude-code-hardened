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
})
