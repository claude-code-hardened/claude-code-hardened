/**
 * CLAUDE_CODE_PROCESS_WRAPPER —— 官方 launcher 协议 1:1 还原
 *
 * 官方 chunk（2.1.283）原文语义：
 *   Sv = "CLAUDE_CODE_PROCESS_WRAPPER"
 *   v(r)   解析状态机（八步校验，文案逐字）
 *   bcn()  状态 store；lu()=argv / Eu()=error / lL()=record
 *   mI()   校验（async：文件存在 + X_OK）
 *   qFe()  诊断消息
 *   Tp()   动态宾语（daemon 已知 → 'daemon'，否则 'background service'）
 *   rNe()  refuse 执行点（stderr + exit 1）
 *
 * 面板行：
 *   error → `warning: ${error} — background sessions will refuse to start
 *            rather than run unwrapped`
 *   record → `launcher: (none running) — this claude resolves \`${record}\`
 *             and will start the next ${Tp()} through it`
 */

import { access, stat } from 'fs/promises'
import { statSync } from 'fs'
import { isAbsolute, join } from 'path'

export const WRAPPER_ENV = 'CLAUDE_CODE_PROCESS_WRAPPER'

export interface WrapperState {
  argv: string[]
  error: null | string
  platformIgnored: boolean
  record: string
}

const EMPTY_STATE: WrapperState = {
  argv: [],
  error: null,
  platformIgnored: false,
  record: '',
}

function errorState(error: string): WrapperState {
  return { argv: [], error, platformIgnored: false, record: '' }
}

/** POSIX shell 词法切分（引号 + 反斜杠转义；不平衡引号抛错——对齐官方 y(r) 抛错路径）。 */
export function shellSplit(raw: string): string[] {
  const argv: string[] = []
  let cur = ''
  let has = false
  let quote: string | null = null
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]!
    if (quote) {
      if (ch === '\\' && quote !== "'") {
        cur += raw[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
        i++
        continue
      }
      cur += ch
      i++
      continue
    }
    if (ch === '\\') {
      cur += raw[i + 1] ?? ''
      has = true
      i += 2
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      i++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (has) {
        argv.push(cur)
        cur = ''
        has = false
      }
      i++
      continue
    }
    cur += ch
    has = true
    i++
  }
  if (quote) throw new Error('unbalanced quote in launcher value')
  if (has) argv.push(cur)
  return argv
}

/** 官方 v(r) 八步校验链——文案逐字对齐。 */
export function parseWrapperState(raw: string): WrapperState {
  if (process.platform === 'win32') {
    return { argv: [], error: null, platformIgnored: true, record: '' }
  }
  let argv: string[]
  try {
    argv = shellSplit(raw)
  } catch (err) {
    return errorState(err instanceof Error ? err.message : String(err))
  }
  if (argv.length === 0) {
    return errorState(
      'the value is set but contains no launcher — unset the variable to run without one, or set it to the absolute path of your launcher',
    )
  }
  const head = argv[0]!
  // 官方第 5 步：防自指（claude 自己的启动路径）
  if (head === process.execPath || head === join(process.cwd(), 'cch')) {
    return errorState(
      `launcher \`${head}\` is Claude Code's own launch path — point ${WRAPPER_ENV} at your launcher, not at claude`,
    )
  }
  if (!isAbsolute(head)) {
    return errorState(
      'the launcher must be an absolute path, not a bare name resolved via PATH',
    )
  }
  let st
  try {
    st = statSync(head)
  } catch {
    return errorState(`launcher \`${head}\` is not an executable file`)
  }
  if (!st.isFile() || (st.mode & 0o111) === 0) {
    return errorState(`launcher \`${head}\` is not an executable file`)
  }
  return { argv, error: null, platformIgnored: false, record: head }
}

// 状态 memo（官方 f 类：memoRaw/memoState；error 出现或变化时报 error）
let memoRaw: string | undefined
let memoState: WrapperState = EMPTY_STATE

export function getState(): WrapperState {
  const raw = process.env[WRAPPER_ENV]
  if (!raw) return EMPTY_STATE
  if (raw === memoRaw && memoState.error === null) return memoState
  const prevError = raw === memoRaw ? memoState.error : null
  memoRaw = raw
  memoState = parseWrapperState(raw)
  if (memoState.error && memoState.error !== prevError) {
    // 官方原文：设置但不可用 — self-spawns 拒绝裸跑
    console.error(
      `${WRAPPER_ENV} is set but can't be used — self-spawns that require it will refuse to start rather than run unwrapped: ${memoState.error}`,
    )
  }
  return memoState
}

/** 官方 lu()。 */
export function getWrapperArgv(): string[] {
  return getState().argv
}

/** 官方 Eu()。 */
export function getWrapperError(): string | null {
  return getState().error
}

/** 官方 lL()——面板 launcher 行的数据源。 */
export function getLauncherRecord(): string {
  return getState().record
}

/** 官方 mI()：launcher 是否可用（error 无 + argv 空视为 true + 文件 X_OK）。 */
export async function isLauncherUsable(): Promise<boolean> {
  if (getWrapperError() !== null) return false
  const argv = getWrapperArgv()
  if (argv.length === 0) return true
  const head = argv[0]
  if (head === undefined || !head.startsWith('/')) return true
  try {
    const st = await stat(head)
    if (!st.isFile()) return false
    await access(head, 0o1)
    return true
  } catch {
    return false
  }
}

/** 官方 qFe()：诊断消息（可用返回 null）。 */
export async function wrapperDiagnostics(): Promise<string | null> {
  const err = getWrapperError()
  if (err) return err
  if (await isLauncherUsable()) return null
  const head = getWrapperArgv()[0] ?? ''
  return `${WRAPPER_ENV}: launcher \`${head}\` was deleted or is not executable — restore it (or fix the setting), then retry`
}

/** 官方 Tp()：daemon 已知（本进程是/能探测到 supervisor）→ 'daemon'。 */
export function serviceKind(isDaemonKnown: boolean): string {
  return isDaemonKnown ? 'daemon' : 'background service'
}

/** 官方 rNe()：refuse 执行点。 */
export function refuse(op: string, reason?: string): never {
  process.stderr.write(
    `'${op}' ${reason ?? 'is not available in this environment'}. `,
  )
  process.exit(1)
}
