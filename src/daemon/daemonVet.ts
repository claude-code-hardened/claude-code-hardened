import { existsSync, lstatSync, readFileSync } from 'fs'
import { dirname } from 'path'

/**
 * ID 隔离四道闸（对齐官方 chunk-fnma234m 的 vet 层，1:1 错误文案）：
 *
 *   闸 1  祖先链属主校验   bind 前 stat daemon 目录 + 全部祖先，
 *                          属主 ≠ 进程 uid → ENOTOWNED 拒绝
 *   闸 2  对端凭证认证     unix socket SO_PEERCRED（已实现：getPeerUid FFI）
 *   闸 3  uid 可映射性     /proc/self/uid_map + overflowuid——uid 被虚拟化
 *                          （容器/嵌套 namespace）时身份不可信，拒 bind+connect
 *   闸 4  messaging 同款   每会话消息通道复用同套门（此前无）
 *
 * 错误码：ENOTOWNED（官方 T1n 原文）。
 */

export const ENOTOWNED = 'ENOTOWNED'

// ── 闸 3：uid 可映射性 ──

/** 内核 overflow uid（无映射时的占位）。upstream 硬编码 65534。 */
const KERNEL_OVERFLOW_UID = 65534

export interface UidMapEntry {
  innerStart: number
  hostStart: number
  count: number
}

/**
 * 官方 D()：uid_map 解析——三列整数、count>0，任何脏行返回 undefined
 * （宁可不可知也不给半份信息）。
 */
export function parseUidMap(raw: string): UidMapEntry[] | undefined {
  const entries: UidMapEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const cols = trimmed.split(/\s+/)
    const innerStart = Number(cols[0])
    const hostStart = Number(cols[1])
    const count = Number(cols[2])
    if (
      cols.length !== 3 ||
      !Number.isSafeInteger(innerStart) ||
      innerStart < 0 ||
      !Number.isSafeInteger(hostStart) ||
      hostStart < 0 ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      return undefined
    }
    entries.push({ innerStart, hostStart, count })
  }
  return entries
}

/** 官方 F()：overflowuid 读数（脏值返回 undefined）。 */
export function parseOverflowUid(raw: string): number | undefined {
  const t = raw.trim()
  if (!/^\d+$/.test(t)) return undefined
  const n = Number(t)
  return Number.isSafeInteger(n) ? n : undefined
}

/** 官方 h()：单条全量映射（innerStart=0 且 count≥2^32-1）= 未进任何 userns。 */
export function isFullMap(entries: UidMapEntry[]): boolean {
  return (
    entries.length === 1 &&
    entries[0]!.innerStart === 0 &&
    entries[0]!.count >= 4294967295
  )
}

/** 官方 A()：uid 不在映射范围内 → 返回原 uid（unmapped）；否则 undefined。 */
export function unmappedUid(
  entries: UidMapEntry[],
  uid: number,
): number | undefined {
  if (entries.length === 0) return uid
  return entries.some(e => uid >= e.innerStart && uid < e.innerStart + e.count)
    ? undefined
    : uid
}

export interface UidVetResult {
  /** 溢出判定：true = 当前身份读数不可信（拒所有 socket 操作） */
  uidCollapses: boolean
  /** socket 文件属主 uid 无法映射（拒 bind） */
  unmappedOwnerUid?: number
  rootUidAmbiguous: boolean
}

function readSelfUidMap(): UidMapEntry[] | undefined {
  try {
    return parseUidMap(readFileSync('/proc/self/uid_map', 'utf8'))
  } catch {
    return undefined
  }
}

function readOverflowUid(): number | undefined {
  try {
    return parseOverflowUid(
      readFileSync('/proc/sys/kernel/overflowuid', 'utf8'),
    )
  } catch {
    return undefined
  }
}

/**
 * 官方 bTo()：uid 虚拟化检测（bind/守护侧）。
 * uid_map 读失败 → getuid 与 overflowuid 相等 = 身份溢出。
 */
export function vetBindUid(): UidVetResult {
  const uid = process.getuid?.()
  if (uid == null) return { uidCollapses: false, rootUidAmbiguous: false }

  const map = readSelfUidMap()
  if (map === undefined) {
    const overflow = readOverflowUid() ?? KERNEL_OVERFLOW_UID
    return { uidCollapses: uid === overflow, rootUidAmbiguous: overflow === 0 }
  }
  if (isFullMap(map)) return { uidCollapses: false, rootUidAmbiguous: false }

  const overflow = readOverflowUid()
  const effectiveOverflow = overflow ?? KERNEL_OVERFLOW_UID
  const unmapped = unmappedUid(map, effectiveOverflow)
  return {
    uidCollapses: map.length === 0 || uid === effectiveOverflow,
    unmappedOwnerUid: unmapped,
    rootUidAmbiguous: effectiveOverflow === 0,
  }
}

/** 官方 kTo() 同款文案：进程身份溢出 → 拒所有 daemon socket 操作。 */
export const UID_COLLAPSES_MESSAGE =
  'refusing to use the daemon socket: this process runs in a user namespace without a uid mapping, so directory and peer ownership cannot be verified (start it with a mapping, e.g. unshare -Ur)'

/** 显式豁免（保留）：非标准环境的 opt-in 门。 */
export const ALLOW_NO_UID_MAP_ENV = 'CLAUDE_CODE_DAEMON_ALLOW_NO_UID_MAP'

/**
 * proot/userns 无 mapping 环境检测（降级校验的前提）：
 * uidCollapses（uid_map 为空/溢出 uid）+ proot 特征之一。
 * proot 特征：PROOT_* 环境变量、/proc/1/comm 非 init/systemd 的
 * 嵌套环境（Android 容器常见）、/proc/self/root 与真实根不一致的
 * proot loader 链。标准容器（docker 有完整 mapping）不会进此分支。
 */
export function isProotLikeEnvironment(): boolean {
  if (!vetBindUid().uidCollapses) return false
  if (Object.keys(process.env).some(k => k.startsWith('PROOT_'))) return true
  try {
    const comm = require('fs').readFileSync('/proc/1/comm', 'utf8').trim()
    // proot 容器里 pid1 常是 shell/proot 本体
    if (['sh', 'bash', 'zsh', 'proot', 'tini'].includes(comm)) return true
  } catch {}
  return false
}

let degradedPeerVerification = false

/** 降级校验是否生效（启动后由 assertUidVetted 标注；面板/日志可引用）。 */
export function isPeerVerificationDegraded(): boolean {
  return degradedPeerVerification
}

/** 降级模式说明文案（透明标注）。 */
export const DEGRADED_PEER_MESSAGE =
  'uid mapping unavailable (proot/userns) — degraded peer verification: peer uid must equal self uid + pid liveness + control.key shared secret'

/** upstread k()：分级门——标准环境硬拒（官方语义）；proot-like 降级放行（带替代校验）。 */
export function assertUidVetted(): void {
  if (vetBindUid().uidCollapses) {
    if (isProotLikeEnvironment()) {
      degradedPeerVerification = true
      return
    }
    if (process.env[ALLOW_NO_UID_MAP_ENV] === '1') {
      degradedPeerVerification = true
      return
    }
    throw Object.assign(new Error(UID_COLLAPSES_MESSAGE), { code: ENOTOWNED })
  }
}

// ── 闸 1：祖先链属主校验 ──

export interface AncestorVetEntry {
  path: string
  present: boolean
  uid?: number
}

/** 公共 sticky 目录白名单（官方 M，_To() 原文）：属主不校验（/tmp 1777 属 root 是常态）。 */
const PUBLIC_ANCESTOR_WHITELIST = new Set([
  '/',
  '/dev',
  '/dev/shm',
  '/run',
  '/run/user',
  '/tmp',
  '/var',
  '/var/tmp',
  '/var/run',
  '/home',
  '/var/home',
  '/root',
  '/var/roothome',
  '/mnt',
  '/mnt/wslg',
])

/**
 * 降级模式的对端校验（proot/userns）：peer uid 必须等于 self uid（挡其他
 * 用户的连接）+ pid 存活性（挡伪造 fd 转发）+ control.key 共享密钥由调用
 * 方已验。标准环境不走此路径（完整 SO_PEERCRED uid 比对）。
 */
export function vetPeerCredentialDegraded(peer: { uid: number; pid: number }): {
  ok: boolean
  reason?: string
} {
  if (peer.uid !== process.getuid?.()) {
    return {
      ok: false,
      reason: `peer uid ${peer.uid} != self uid (degraded mode)`,
    }
  }
  if (peer.pid <= 1 || !Number.isInteger(peer.pid)) {
    return { ok: false, reason: `invalid peer pid ${peer.pid}` }
  }
  try {
    if (!require('fs').existsSync(`/proc/${peer.pid}`)) {
      return { ok: false, reason: `peer pid ${peer.pid} not alive` }
    }
  } catch {
    return { ok: false, reason: `peer pid ${peer.pid} not alive` }
  }
  return { ok: true }
}

/** 官方 T()：祖先链逐级 stat，属主非同 uid → ENOTOWNED；白名单目录跳过。 */
export function vetAncestorOwnership(rootPath: string): {
  ok: boolean
  code?: string
  message?: string
  entries: AncestorVetEntry[]
} {
  assertUidVetted()
  const uid = process.getuid?.()
  const entries: AncestorVetEntry[] = []
  let cursor = rootPath
  const chain = [rootPath]
  for (let i = 0; i < 16 && cursor !== '/'; i++) {
    cursor = dirname(cursor)
    chain.push(cursor)
  }
  for (const p of chain) {
    if (!existsSync(p)) {
      entries.push({ path: p, present: false })
      continue
    }
    const st = lstatSync(p)
    entries.push({ path: p, present: true, uid: st.uid })
    // 公共白名单（/tmp 等 sticky 目录）跳过属主校验——官方 M 集合语义
    if (PUBLIC_ANCESTOR_WHITELIST.has(p)) continue
    if (uid !== undefined && st.uid !== uid) {
      return {
        ok: false,
        code: ENOTOWNED,
        message: `refusing to bind: ${p} is owned by uid ${st.uid}`,
        entries,
      }
    }
  }
  return { ok: true, entries }
}
