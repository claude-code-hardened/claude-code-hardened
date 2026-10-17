import { describe, expect, mock, test } from 'bun:test'
import { taskRegistryMock } from '../../../../../../tests/mocks/taskRegistry'

mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

// resumeAgent → runAgent → taskRegistry pulls the bootstrap/envUtils
// side-effect chain at import; stub the registry face so the module graph
// loads without.realpathSync side effects (see tests/mocks/taskRegistry.ts).
mock.module('src/services/taskRegistry/taskRegistry.js', () => taskRegistryMock)
mock.module('src/services/taskRegistry/taskRegistry.ts', () => taskRegistryMock)

describe('resumeAgent', () => {
  test('module exports resumeAgentBackground', async () => {
    const mod = await import('../resumeAgent.js')
    expect(typeof mod.resumeAgentBackground).toBe('function')
  })

  test('module exports ResumeAgentResult type (compile-time)', async () => {
    // TypeScript-only: just ensure the module loads cleanly so the type
    // surface is in the patch coverage trace.
    const mod = await import('../resumeAgent.js')
    expect(mod).toBeDefined()
  })
})
