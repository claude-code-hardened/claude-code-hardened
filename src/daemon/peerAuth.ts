import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/**
 * 通用防伪造层（challenge-response）——不依赖内核凭证，标准/proot 环境一致。
 *
 * 威胁模型：proot/userns 下 SO_PEERCRED 的 uid 无区分度（全员同 uid）且
 * pid 可谎报。这里用密码学层补齐：
 *   1. challenge-response：server 发 32B 随机 nonce，client 回
 *      HMAC-SHA256(control.key, nonce)——key 永不出现在线上，无 key 的
 *      进程无法伪造响应；
 *   2. timingSafeEqual 比对（抗时序侧信道）；
 *   3. 失败限速（滑窗，连续失败临时拒连——纵深防御）；
 *   4. 对端 binary 交叉验证（辅助层：/proc/<pid>/exe 指向同一可执行文件；
 *      读不到时记 warn 不硬拒——proot 下 /proc 视图可能受限）。
 */

const CHALLENGE_BYTES = 32
const HMAC_HEX_LEN = 64

/** 生成 32B 随机 nonce（hex）。 */
export function createChallenge(): string {
  return randomBytes(CHALLENGE_BYTES).toString('hex')
}

/** 客户端应答：HMAC-SHA256(key, nonce) hex。 */
export function signChallenge(key: string, nonce: string): string {
  return createHmac('sha256', key).update(nonce).digest('hex')
}

/** 服务端验证（长度守卫 + timingSafeEqual）。 */
export function verifyChallenge(
  key: string,
  nonce: string,
  presentedHex: string,
): boolean {
  if (typeof presentedHex !== 'string' || presentedHex.length !== HMAC_HEX_LEN)
    return false
  if (typeof nonce !== 'string' || nonce.length !== CHALLENGE_BYTES * 2)
    return false
  const expected = Buffer.from(signChallenge(key, nonce), 'hex')
  const presented = Buffer.from(presentedHex, 'hex')
  if (expected.length !== presented.length) return false
  return timingSafeEqual(expected, presented)
}

/** 滑窗失败限速：连续 failLimit 次失败后锁 failLockMs。 */
export class PeerRateLimiter {
  private failures = 0
  private lockedUntil = 0
  constructor(
    private readonly failLimit = 5,
    private readonly failLockMs = 60_000,
  ) {}

  isLocked(): boolean {
    if (this.lockedUntil === 0) return false
    if (Date.now() < this.lockedUntil) return true
    this.lockedUntil = 0
    this.failures = 0
    return false
  }

  recordSuccess(): void {
    this.failures = 0
  }

  recordFailure(): number {
    this.failures += 1
    if (this.failures >= this.failLimit) {
      this.lockedUntil = Date.now() + this.failLockMs
      this.failures = 0
    }
    return this.failures
  }

  /** 剩余锁秒数（0 = 未锁）。 */
  lockedForSec(): number {
    if (this.lockedUntil === 0) return 0
    return Math.max(0, Math.ceil((this.lockedUntil - Date.now()) / 1000))
  }
}

/**
 * 对端 binary 交叉验证（辅助层）：/proc/<pid>/exe 应指向与本进程相同的
 * 可执行文件。proot 下 /proc 视图可能受限——读取失败返回 unknown（调用
 * 方决定是否降级），明确指向别的 binary 时返回 mismatch（硬拒依据）。
 */
export function verifyPeerBinary(
  pid: number,
): 'match' | 'mismatch' | 'unknown' {
  try {
    const exe = require('fs').readlinkSync(`/proc/${pid}/exe`)
    if (exe === process.execPath) return 'match'
    // bundled 单文件：exe 可能是 runner 自身；cmdline 兜底比对
    const cmd =
      require('fs')
        .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .split('\0')[0] ?? ''
    if (cmd === process.execPath) return 'match'
    return 'mismatch'
  } catch {
    return 'unknown'
  }
}
