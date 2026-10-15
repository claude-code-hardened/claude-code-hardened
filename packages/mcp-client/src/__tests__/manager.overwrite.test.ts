import { describe, expect, test, mock } from 'bun:test'
import { createMcpManager } from '../manager.js'
import type { McpClientDependencies } from '../interfaces.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from '../types.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

function createMockDeps(): McpClientDependencies {
  return {
    logger: {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    },
    httpConfig: {
      getUserAgent: () => 'test-agent/1.0',
      getSessionId: () => 'test-session',
    },
  }
}

function makeConnectedConnection(
  name: string,
  cleanup: () => Promise<void> = () => Promise.resolve(),
): ConnectedMCPServer {
  return {
    type: 'connected',
    name,
    client: {
      // request() serves the tools/list discovery done by connect()
      request: mock(() => Promise.resolve({ tools: [] })),
      // callTool() serves manager.callTool() — captures the invoke options
      callTool: mock(() => Promise.resolve({ content: [] })),
      onclose: null,
    } as unknown as Client,
    capabilities: {},
    config: {
      command: 'npx',
      args: [],
      scope: 'dynamic',
    } as ScopedMcpServerConfig,
    cleanup: mock(cleanup),
  }
}

describe('McpManager connect overwrite', () => {
  test('re-connecting the same name cleans up the previous connection', async () => {
    const manager = createMcpManager(createMockDeps()) as any

    const oldCleanup = mock(() => Promise.resolve())
    const newCleanup = mock(() => Promise.resolve())
    const oldConnection = makeConnectedConnection('dup-server', oldCleanup)
    const newConnection = makeConnectedConnection('dup-server', newCleanup)

    let disconnectedEvents = 0
    manager.on('disconnected', () => {
      disconnectedEvents++
    })

    const connections = [oldConnection, newConnection]
    let connectCalls = 0
    manager.setConnectFn(async () => connections[connectCalls++])

    await manager.connect('dup-server', { command: 'npx', args: [] })
    expect(oldCleanup).not.toHaveBeenCalled()

    // Second connect with the same name must tear down the first connection
    // instead of leaking its transport via a silent Map.set overwrite.
    await manager.connect('dup-server', { command: 'npx', args: [] })

    expect(oldCleanup).toHaveBeenCalled()
    expect(newCleanup).not.toHaveBeenCalled()
    expect(disconnectedEvents).toBe(1)
    expect(manager.getConnections().size).toBe(1)
  })

  test('overwritten connection toolsCache is replaced for the same name', async () => {
    const manager = createMcpManager(createMockDeps()) as any

    const oldCleanup = mock(() => Promise.resolve())
    manager.setConnectFn(async () =>
      makeConnectedConnection('stale-server', oldCleanup),
    )

    await manager.connect('stale-server', { command: 'npx', args: [] })
    expect(manager.getTools('stale-server')).toEqual([])

    const cleanupBeforeSecond = oldCleanup.mock.calls.length
    await manager.connect('stale-server', { command: 'npx', args: [] })
    expect(oldCleanup.mock.calls.length).toBe(cleanupBeforeSecond + 1)
  })
})

describe('McpManager callTool cancellability', () => {
  test('injected AbortSignal is passed through to the underlying client.callTool', async () => {
    const manager = createMcpManager(createMockDeps()) as any

    const connection = makeConnectedConnection('sig-server')
    manager.setConnectFn(async () => connection)
    await manager.connect('sig-server', { command: 'npx', args: [] })

    const externalController = new AbortController()
    await manager.callTool(
      'sig-server',
      'echo',
      { msg: 'hi' },
      {
        signal: externalController.signal,
      },
    )

    expect(connection.client.callTool).toHaveBeenCalled()
    const invokeOptions = (connection.client.callTool as any).mock
      .calls[0][2] as { signal: AbortSignal; timeout: number }
    expect(invokeOptions.signal).toBe(externalController.signal)
    // Default timeout magnitude preserved (upstream-parity ~27.8h)
    expect(invokeOptions.timeout).toBe(100_000_000)
  })

  test('timeoutMs override is passed through and 3-arg calls stay compatible', async () => {
    const manager = createMcpManager(createMockDeps()) as any

    const connection = makeConnectedConnection('timeout-server')
    manager.setConnectFn(async () => connection)
    await manager.connect('timeout-server', { command: 'npx', args: [] })

    await manager.callTool('timeout-server', 'echo', {})
    await manager.callTool('timeout-server', 'echo', {}, { timeoutMs: 1234 })

    const calls = (connection.client.callTool as any).mock.calls as Array<
      [unknown, unknown, { timeout: number }]
    >
    expect(calls[0][2].timeout).toBe(100_000_000)
    expect(calls[1][2].timeout).toBe(1234)
  })
})
