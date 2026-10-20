import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
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
// Shell mock 同样必须携带完整导出面（exec/getShellConfig/getPsProvider…），
// 否则同进程其他文件（或 CdTool 的传递依赖图）对 Shell 的具名导入在 ESM
// 链接期报 "Export named 'exec' not found"。真实命名空间仅取 keys 兜底。
// .js 扩展名（tsconfig allowImportingTsExtensions 未开，.ts 静态导入 TS5097；
// Bun 运行时把 .js 解析回 .ts 源文件——与 src/ 内部导入约定一致）。
import * as realShellModule from 'src/utils/Shell.js'
const shellSnapshot: Record<string, unknown> = { ...realShellModule }
mock.module('src/utils/Shell.ts', () => {
  const noop = () => {}
  const baseline: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(shellSnapshot)) {
    if (name === 'setCwd') continue
    baseline[name] = typeof value === 'function' ? noop : value
  }
  return { ...baseline, setCwd: setCwdMock }
})
mock.module('src/utils/sessionEnvironment.ts', () => ({
  invalidateSessionEnvCache: invalidateSessionEnvCacheMock,
}))
mock.module('src/utils/hooks/fileChangedWatcher.ts', () => ({
  onCwdChangedForHooks: onCwdChangedForHooksMock,
}))

// 跨文件 mock.module 污染修复（清单 #6）：本文件不再部分替换
// src/bootstrap/state.ts —— Bun 的 ESM 链接期按 mock 模块的自有属性校验
// 消费方的具名导入，缺一个导出（如 waitForScrollIdle，经
// utils/git/gitFilesystem 的静态导入链进 CdTool 的真实依赖图）就让整个
// worker 抛 "Export named '...' not found"，且 mock 进程级不可撤、任意
// 顺序皆脆。改用真实模块 + 真实 setter 锚定（ShellCommand.test.ts 同款
// 快照/还原模式），只保留 Shell / 会话环境 / 钩子看门人等纯接缝 mock。
import * as bootstrapStateModule from 'src/bootstrap/state.js'
const bootstrapStateSnapshot: Record<string, unknown> = {
  ...bootstrapStateModule,
}
const { getOriginalCwd, setCwdState } = bootstrapStateModule as unknown as {
  getOriginalCwd: () => string
  setCwdState: (cwd: string) => void
}
const sessionRoot = realpathSync(process.cwd())
// 锚定真实存在的目录（相对路径与 "same" 判定都 stat 得到）。
bootstrapStateModule.setOriginalCwd(sessionRoot)
bootstrapStateModule.setCwdState(sessionRoot)

// cwd 工具链不再 mock：真实 src/utils/cwd.ts 的 holder-shape override 就是
// 并发修复本体，也是本文件并发测试的被测面。
const { runWithCwdOverride, getCwd } = await import('src/utils/cwd.js')

const { CdTool } = await import('../CdTool.js')
const { CD_TOOL_NAME } = await import('../constants.js')
const { TOOL_VALIDATION_CONFIG } = await import(
  'src/utils/settings/toolValidationConfig.js'
)

afterAll(() => {
  // 进程卫生（mock.module 之外的真实状态也要还原——快照式恢复，见
  // ShellCommand.test.ts 同款模式；防其他测试文件读到 Cd 的锚定 cwd）。
  for (const [name, value] of Object.entries(bootstrapStateSnapshot)) {
    try {
      ;(bootstrapStateModule as unknown as Record<string, unknown>)[name] =
        value
    } catch {
      // setter-only exports — restore via the snapshot's captured values is
      // best effort; the afterEach anchors below cover the cwd pair.
    }
  }
})

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

    test('per-agent cwd override: cd writes the override layer, not the global state', async () => {
      // 并发竞态修复回归钉：子代理在 runWithCwdOverride 上下文里 cd 时，
      // 目标必须写 override 层（getCwd 读取优先级一致），绝不写全局
      // setCwd（否则并发代理互相覆盖工作目录视图）。
      const target = join(tmpDir, 'agent-one')
      mkdirSync(target)
      const agentRoot = join(tmpDir, 'agent-root')
      mkdirSync(agentRoot)

      await runWithCwdOverride(agentRoot, async () => {
        const result = await CdTool.call({ path: target }, NO_RULES_CTX)

        expect(result.data.error).toBeUndefined()
        expect(result.data.directory).toBe(target)
        // 全局状态写路径绝不能触发。
        expect(setCwdMock).not.toHaveBeenCalled()
        // override 层生效：上下文内的 pwd()/getCwd() 看到新目录。
        expect(getCwd()).toBe(target)
        // 会话全局状态没有被污染——模拟"另一个代理"的视角（不同
        // AsyncLocalStorage 上下文，无 override）仍读全局状态（锚定值）。
        expect(
          (
            bootstrapStateModule as unknown as { getCwdState: () => string }
          ).getCwdState(),
        ).toBe(sessionRoot)
      })
      // 代理上下文结束后，全局状态同样未被污染。
      expect(setCwdMock).not.toHaveBeenCalled()
    })

    test('concurrent agents cd racing do not overwrite each other (per-context isolation)', async () => {
      const dirA = join(tmpDir, 'race-a')
      const dirB = join(tmpDir, 'race-b')
      const rootA = join(tmpDir, 'root-a')
      const rootB = join(tmpDir, 'root-b')
      for (const dir of [dirA, dirB, rootA, rootB]) mkdirSync(dir)

      await Promise.all([
        runWithCwdOverride(rootA, async () => {
          await Bun.sleep(5)
          const result = await CdTool.call({ path: dirA }, NO_RULES_CTX)
          expect(result.data.error).toBeUndefined()
          // A 的最终视图是 A 的目标。
          expect(getCwd()).toBe(dirA)
          expect(setCwdMock).not.toHaveBeenCalled()
        }),
        runWithCwdOverride(rootB, async () => {
          await Bun.sleep(1)
          const result = await CdTool.call({ path: dirB }, NO_RULES_CTX)
          expect(result.data.error).toBeUndefined()
          expect(getCwd()).toBe(dirB)
        }),
      ])
      // 全局状态零写入：并发 cd 全程走 override 层。
      expect(setCwdMock).not.toHaveBeenCalled()
      expect(
        (
          bootstrapStateModule as unknown as { getCwdState: () => string }
        ).getCwdState(),
      ).toBe(sessionRoot)
    })

    test('no override in context: cd still writes the global state (main-session path)', async () => {
      const target = join(tmpDir, 'main')
      mkdirSync(target)

      const result = await CdTool.call({ path: target }, NO_RULES_CTX)

      expect(result.data.error).toBeUndefined()
      expect(setCwdMock).toHaveBeenCalledWith(target)
    })
  })
})
