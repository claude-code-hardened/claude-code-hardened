/**
 * Tests for the MCP completions capability surface (0034 anchor semantics):
 * capabilities.completions negotiation, resources/templates/list enumeration
 * (LRU cache + invalidation), and complete_resource_template with context
 * omission. All clients are in-process stubs — no network, no bootstrap
 * state (log.ts mocked out).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

import { logMock } from '../../../../tests/mocks/log.js'
mock.module('src/utils/log.ts', logMock)

import {
  clearResourceTemplatesCache,
  completeResourceTemplate,
  fetchResourceTemplatesForClient,
  supportsCompletions,
} from '../completions.js'
import type { CompletionConnection } from '../completions.js'

function makeConnection(
  overrides: Partial<CompletionConnection> & {
    listResourceTemplates?: () => Promise<unknown>
    complete?: (params: unknown) => Promise<unknown>
  },
): CompletionConnection {
  const { listResourceTemplates, complete, ...connection } = overrides
  return {
    name: connection.name ?? 'stub-server',
    capabilities: connection.capabilities ?? {
      resources: { listChanged: false },
      completions: {},
    },
    client: {
      listResourceTemplates:
        listResourceTemplates ??
        (() =>
          Promise.resolve({
            resourceTemplates: [
              {
                uriTemplate: 'file:///{path}',
                name: 'files',
                description: 'a template',
              },
            ],
          })),
      complete:
        complete ??
        (() => Promise.resolve({ completion: { values: ['a', 'b'] } })),
    } as unknown as Client,
  }
}

beforeEach(() => {
  clearResourceTemplatesCache('stub-server')
})

describe('supportsCompletions', () => {
  test('true when the server declares the completions capability', () => {
    expect(supportsCompletions({ completions: {} })).toBe(true)
  })

  test('false when capability is missing (negotiated off)', () => {
    expect(supportsCompletions(undefined)).toBe(false)
    expect(supportsCompletions(null)).toBe(false)
    expect(supportsCompletions({})).toBe(false)
    expect(supportsCompletions({ resources: {} })).toBe(false)
  })
})

describe('fetchResourceTemplatesForClient', () => {
  test('tags templates with the server name', async () => {
    const connection = makeConnection({ name: 'tagging-server' })
    const templates = await fetchResourceTemplatesForClient(connection)
    expect(templates).toHaveLength(1)
    expect(templates[0].uriTemplate).toBe('file:///{path}')
    expect(templates[0].server).toBe('tagging-server')
  })

  test('returns [] when the server lacks the resources capability', async () => {
    let called = false
    const connection = makeConnection({
      name: 'no-resources',
      capabilities: {},
      listResourceTemplates: () => {
        called = true
        return Promise.resolve({ resourceTemplates: [] })
      },
    })
    const templates = await fetchResourceTemplatesForClient(connection)
    expect(templates).toEqual([])
    expect(called).toBe(false)
  })

  test('degrades to [] when enumeration fails', async () => {
    const connection = makeConnection({
      name: 'failing-templates',
      listResourceTemplates: () => Promise.reject(new Error('boom')),
    })
    const templates = await fetchResourceTemplatesForClient(connection)
    expect(templates).toEqual([])
  })
})

describe('clearResourceTemplatesCache', () => {
  test('forces re-enumeration on the next fetch', async () => {
    let calls = 0
    const connection = makeConnection({
      name: 'cached-server',
      listResourceTemplates: () => {
        calls += 1
        return Promise.resolve({
          resourceTemplates: [{ uriTemplate: 'db://t/{id}', name: 't' }],
        })
      },
    })

    await fetchResourceTemplatesForClient(connection)
    await fetchResourceTemplatesForClient(connection)
    expect(calls).toBe(1) // memoized per server name

    clearResourceTemplatesCache('cached-server')
    await fetchResourceTemplatesForClient(connection)
    expect(calls).toBe(2)
  })

  test('W6: same-name servers with different configs never cross-read the cache', async () => {
    let projectCalls = 0
    let userCalls = 0
    const projectConnection = makeConnection({
      name: 'dual-server',
      listResourceTemplates: () => {
        projectCalls += 1
        return Promise.resolve({
          resourceTemplates: [{ uriTemplate: 'project://t/{id}', name: 'p' }],
        })
      },
    })
    const userConnection = makeConnection({
      name: 'dual-server',
      listResourceTemplates: () => {
        userCalls += 1
        return Promise.resolve({
          resourceTemplates: [{ uriTemplate: 'user://t/{id}', name: 'u' }],
        })
      },
    })
    // Identity = scope + endpoint fingerprint: same display name, two distinct
    // config identities must not share a cache entry.
    ;(projectConnection as { config?: unknown }).config = {
      scope: 'project',
      type: 'stdio',
      command: 'node',
      args: ['server-a.js'],
    }
    ;(userConnection as { config?: unknown }).config = {
      scope: 'user',
      type: 'stdio',
      command: 'node',
      args: ['server-b.js'],
    }

    await fetchResourceTemplatesForClient(projectConnection)
    await fetchResourceTemplatesForClient(userConnection)
    expect(projectCalls).toBe(1)
    expect(userCalls).toBe(1)

    // Identical identity (same connection object) hits the same entry.
    await fetchResourceTemplatesForClient(projectConnection)
    expect(projectCalls).toBe(1)
    expect(userCalls).toBe(1)

    // Clear-by-name drops every identity entry of the server.
    clearResourceTemplatesCache('dual-server')
    await fetchResourceTemplatesForClient(projectConnection)
    await fetchResourceTemplatesForClient(userConnection)
    expect(projectCalls).toBe(2)
    expect(userCalls).toBe(2)
  })
})

describe('completeResourceTemplate', () => {
  test('returns completion.values from the server', async () => {
    const connection = makeConnection({ name: 'complete-ok' })
    const values = await completeResourceTemplate(
      connection,
      'file:///{path}',
      'path',
      'sr',
    )
    expect(values).toEqual(['a', 'b'])
  })

  test('skips the request when completions are not negotiated', async () => {
    let called = false
    const connection = makeConnection({
      name: 'no-completions',
      capabilities: { resources: {} },
      complete: () => {
        called = true
        return Promise.resolve({ completion: { values: ['x'] } })
      },
    })
    const values = await completeResourceTemplate(
      connection,
      'file:///{path}',
      'path',
      'sr',
    )
    expect(values).toEqual([])
    expect(called).toBe(false)
  })

  test('omits context entirely when no prior arguments (official anchor)', async () => {
    let captured: unknown
    const connection = makeConnection({
      name: 'context-shape',
      complete: params => {
        captured = params
        return Promise.resolve({ completion: { values: [] } })
      },
    })
    await completeResourceTemplate(connection, 'file:///{path}', 'path', '')
    expect((captured as { context?: unknown }).context).toBeUndefined()

    await completeResourceTemplate(connection, 'file:///{path}', 'path', '', {
      path: 'src',
    })
    expect((captured as { context?: unknown }).context).toEqual({
      arguments: { path: 'src' },
    })
    expect((captured as { ref: unknown }).ref).toEqual({
      type: 'ref/resource',
      uri: 'file:///{path}',
    })
  })

  test('degrades to [] when the server rejects the request', async () => {
    const connection = makeConnection({
      name: 'complete-fails',
      complete: () => Promise.reject(new Error('rejected')),
    })
    const values = await completeResourceTemplate(
      connection,
      'file:///{path}',
      'path',
      'sr',
    )
    expect(values).toEqual([])
  })
})
