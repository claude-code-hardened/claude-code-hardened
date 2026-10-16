import { AsyncLocalStorage } from 'async_hooks'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { logMock } from '../../../../../../tests/mocks/log'
import { functionalStateMock } from '../../../../../../tests/mocks/state'

// Shell.js / sessionEnvironment / fileChangedWatcher pull the analytics +
// settings chains; the Cd flow only consumes their three sync entry points.
// Cut them at the seams so the tests exercise CdTool's own logic.
const setCwdMock = mock((_path: string) => {})
const invalidateSessionEnvCacheMock = mock(() => {})
// Two-arg signature matches the real onCwdChangedForHooks(oldCwd, newCwd) —
// needed so mock.calls tuples carry the newCwd assertion below.
const onCwdChangedForHooksMock = mock(
  async (_oldCwd: string, _newCwd: string) => {},
)

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/Shell.ts', () => ({ setCwd: setCwdMock }))
mock.module('src/utils/sessionEnvironment.ts', () => ({
  invalidateSessionEnvCache: invalidateSessionEnvCacheMock,
}))
mock.module('src/utils/hooks/fileChangedWatcher.ts', () => ({
  onCwdChangedForHooks: onCwdChangedForHooksMock,
}))

// Cross-file mock.module pollution（进程级 last-write-wins）：其他测试文件对
// src/bootstrap/state 注册的 stateMock（getOriginalCwd → '/mock/cwd'，目录在
// 磁盘上不存在）与对 src/utils/cwd 的桩会泄漏进本文件，使 Cd 的 no-op
// （"same"）判定与相对路径锚定 stat 到不存在的路径——CI 报
// `cd: not_found — Path "/mock/cwd" does not exist`。这里重新注册带真实
// 状态的 mock，锚定到真实存在的目录（realpathSync(process.cwd())）。
type StateHandle = {
  setOriginalCwd: (cwd: string) => void
  setCwdState: (cwd: string) => void
  getCwdState: () => string
  getOriginalCwd: () => string
}
const stateHandle = functionalStateMock() as unknown as StateHandle
const sessionRoot = realpathSync(process.cwd())
stateHandle.setOriginalCwd(sessionRoot)
stateHandle.setCwdState(sessionRoot)
// mock.module's signature expects a factory; returning the same handle keeps
// runtime parity with the plain-object form used until now.
mock.module('src/bootstrap/state.ts', () => stateHandle)
mock.module('src/bootstrap/state.js', () => stateHandle)

const cwdOverrideStorage = new AsyncLocalStorage<string>()
const cwdMock = () => ({
  runWithCwdOverride: (cwd: string, fn: () => unknown) =>
    cwdOverrideStorage.run(cwd, fn as () => never),
  pwd: () => cwdOverrideStorage.getStore() ?? stateHandle.getCwdState(),
  getCwd: () => cwdOverrideStorage.getStore() ?? stateHandle.getCwdState(),
})
mock.module('src/utils/cwd.ts', cwdMock)
mock.module('src/utils/cwd.js', cwdMock)

const { CdTool } = await import('../CdTool.js')
const { CD_TOOL_NAME } = await import('../constants.js')
const { getOriginalCwd, setCwdState } = await import('src/bootstrap/state.js')
const { TOOL_VALIDATION_CONFIG } = await import(
  'src/utils/settings/toolValidationConfig.js'
)

type RulesForTest = {
  deny?: string[]
  allow?: string[]
}

function ctxWithRules(rules: RulesForTest): never {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        alwaysDenyRules: rules.deny ? { projectSettings: rules.deny } : {},
        alwaysAllowRules: rules.allow ? { projectSettings: rules.allow } : {},
        alwaysAskRules: {},
      },
    }),
  } as never
}

const NO_RULES_CTX = { getAppState: () => ({}) } as never

describe('CdTool', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'cd-tool-')))
    setCwdMock.mockClear()
    invalidateSessionEnvCacheMock.mockClear()
    onCwdChangedForHooksMock.mockClear()
  })

  afterEach(() => {
    // Restore the session cwd anchor (the relative-path test re-anchors it).
    setCwdState(getOriginalCwd())
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('declares the official tool name "Cd"', () => {
    expect(CD_TOOL_NAME).toBe('Cd')
    expect(CdTool.name).toBe('Cd')
  })

  test('is registered in the filePatternTools permission whitelist', () => {
    expect(TOOL_VALIDATION_CONFIG.filePatternTools).toContain('Cd')
  })

  describe('successful directory change', () => {
    test('switches into an existing directory and syncs session cwd', async () => {
      const target = join(tmpDir, 'target')
      mkdirSync(target)

      const result = await CdTool.call({ path: target }, NO_RULES_CTX)

      expect(result.data.error).toBeUndefined()
      expect(result.data.directory).toBe(target)
      expect(result.data.message).toContain(target)
      expect(setCwdMock).toHaveBeenCalledWith(target)
      expect(invalidateSessionEnvCacheMock).toHaveBeenCalled()
      expect(onCwdChangedForHooksMock).toHaveBeenCalledTimes(1)
      expect(onCwdChangedForHooksMock.mock.calls[0]?.[1]).toBe(target)
    })

    test('resolves relative paths against the current working directory', async () => {
      const target = join(tmpDir, 'nested', 'deep')
      mkdirSync(target, { recursive: true })
      // Anchor the session cwd at the fixture so a relative path resolves
      // against it (matches how getCwd() feeds resolveCdTarget).
      setCwdState(tmpDir)

      const result = await CdTool.call(
        { path: join('.', 'nested', 'deep') },
        NO_RULES_CTX,
      )

      expect(result.data.error).toBeUndefined()
      expect(result.data.directory).toBe(target)
      expect(setCwdMock).toHaveBeenCalledWith(target)
    })

    test('no-op when the target equals the session and original cwd', async () => {
      // Official `same` result: target === current cwd === original cwd.
      const original = getOriginalCwd()
      const result = await CdTool.call({ path: original }, NO_RULES_CTX)

      expect(result.data.error).toBeUndefined()
      expect(result.data.message).toContain('Already in')
      expect(setCwdMock).not.toHaveBeenCalled()
      expect(invalidateSessionEnvCacheMock).not.toHaveBeenCalled()
    })
  })

  describe('~ expansion', () => {
    test('expands ~ to the home directory on success', async () => {
      const result = await CdTool.call({ path: '~/' }, NO_RULES_CTX)

      expect(result.data.error).toBeUndefined()
      expect(result.data.directory).toBe(realpathSync(homedir()))
      expect(setCwdMock).toHaveBeenCalledWith(realpathSync(homedir()))
    })

    test('expands ~/name for nonexistent targets in validateInput', async () => {
      // CdTool.validateInput takes only the input (no context param).
      const validation = await CdTool.validateInput?.({
        path: '~/cd-tool-missing-dir-xyz',
      })

      expect(validation).toMatchObject({ result: false })
      if (!validation.result) {
        expect(validation.message).toContain(homedir())
        expect(validation.message).toContain('does not exist')
      }
    })
  })

  describe('target validation failures', () => {
    test('rejects nonexistent directories', async () => {
      const missing = join(tmpDir, 'does-not-exist')
      const result = await CdTool.call({ path: missing }, NO_RULES_CTX)

      expect(result.data.error).toContain('not_found')
      expect(result.data.error).toContain(missing)
      expect(setCwdMock).not.toHaveBeenCalled()
    })

    test('rejects paths that are not directories', async () => {
      const target = join(tmpDir, 'file.txt')
      writeFileSync(target, 'content')

      const result = await CdTool.call({ path: target }, NO_RULES_CTX)

      expect(result.data.error).toContain('not_a_directory')
      expect(result.data.error).toContain(tmpDir)
      expect(setCwdMock).not.toHaveBeenCalled()
    })
  })

  describe('permission rules', () => {
    test('bare deny rule blocks every directory change (blocked_by_rule)', async () => {
      const target = join(tmpDir, 'anywhere')
      mkdirSync(target)

      const result = await CdTool.call(
        { path: target },
        ctxWithRules({
          deny: ['Cd'],
        }),
      )

      expect(result.data.error).toContain('blocked_by_rule')
      expect(setCwdMock).not.toHaveBeenCalled()
    })

    test('patterned deny rule blocks the matching directory', async () => {
      const target = join(tmpDir, 'forbidden')
      mkdirSync(target)

      const result = await CdTool.call(
        { path: target },
        ctxWithRules({
          deny: [`Cd(${target})`],
        }),
      )

      expect(result.data.error).toContain('blocked_by_rule')
      expect(setCwdMock).not.toHaveBeenCalled()
    })

    test('checkPermissions denies matching deny rules with a rule reason', async () => {
      const target = join(tmpDir, 'forbidden')
      mkdirSync(target)

      const decision = await CdTool.checkPermissions(
        { path: target },
        ctxWithRules({ deny: [`Cd(${tmpDir}/**)`] }),
      )

      expect(decision).toMatchObject({ behavior: 'deny' })
      if (decision.behavior === 'deny') {
        expect(decision.decisionReason).toMatchObject({ type: 'rule' })
      }
    })

    test('realpath escape outside the allow-rule root is refused', async () => {
      // real directory allowed by rule, symlink inside it pointing to /etc:
      // the canonical realpath escapes the rule root → must be refused.
      const inside = join(tmpDir, 'inside')
      mkdirSync(inside)
      symlinkSync('/etc', join(inside, 'escape'))

      const result = await CdTool.call({ path: join(inside, 'escape') }, {
        getAppState: () => ({
          toolPermissionContext: {
            alwaysDenyRules: {},
            alwaysAllowRules: {
              projectSettings: [`Cd(${inside}/**)`],
            },
            alwaysAskRules: {},
          },
        }),
      } as never)

      expect(result.data.error).toContain('outside_allowed_patterns')
      expect(setCwdMock).not.toHaveBeenCalled()
    })

    test('allow list refuses directories outside every allow pattern', async () => {
      const outside = join(tmpDir, 'outside')
      mkdirSync(outside)

      const result = await CdTool.call({ path: outside }, {
        getAppState: () => ({
          toolPermissionContext: {
            alwaysDenyRules: {},
            alwaysAllowRules: {
              projectSettings: [`Cd(${join(tmpDir, 'somewhere-else')}/**)`],
            },
            alwaysAskRules: {},
          },
        }),
      } as never)

      expect(result.data.error).toContain('outside_allowed_patterns')
      expect(setCwdMock).not.toHaveBeenCalled()
    })

    test('matching allow rule permits the change', async () => {
      const inside = join(tmpDir, 'inside', 'deep')
      mkdirSync(inside, { recursive: true })

      const result = await CdTool.call({ path: inside }, {
        getAppState: () => ({
          toolPermissionContext: {
            alwaysDenyRules: {},
            alwaysAllowRules: {
              projectSettings: [`Cd(${join(tmpDir, 'inside')}/**)`],
            },
            alwaysAskRules: {},
          },
        }),
      } as never)

      expect(result.data.error).toBeUndefined()
      expect(result.data.directory).toBe(inside)
      expect(setCwdMock).toHaveBeenCalledWith(inside)
    })

    test('no rules at all allows any directory change', async () => {
      const target = join(tmpDir, 'free')
      mkdirSync(target)

      const result = await CdTool.call({ path: target }, NO_RULES_CTX)

      expect(result.data.error).toBeUndefined()
      expect(setCwdMock).toHaveBeenCalledWith(target)
    })
  })
})
