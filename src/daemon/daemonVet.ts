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

/** upstread k()：在门上抛（同步、可复用）。 */
export function assertUidVetted(): void {
  if (vetBindUid().uidCollapses) {
    throw Object.assign(new Error(UID_COLLAPSES_MESSAGE), { code: ENOTOWNED })
  }
}

// ── 闸 1：祖先链属主校验 ──

export interface AncestorVetEntry {
  path: string
  present: boolean
  uid?: number
}

/** 官方 T()：祖先链逐级 stat，属主非同 uid → ENOTOWNED；权限偏差 → chmod 0700。 */
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
