/**
 * Tests for CCH #52 (R1-low) SendMessageTool 转发链护栏——官方 hop 准入双口径。
 *
 * 官方真源 docs/reverse-284/decompiled/0258-chunk-116j5z58/
 * module-005-uncategorized.js:117 Tan={maxSelfHops:10,maxChainLength:28} +
 * :121 g(d,o)：链长 > maxChainLength → "hop-runaway"；链中自会话 id 出现
 * ≥ maxSelfHops → "hop-loop"；仅 peer origin 参检（官方 vr 只查
 * origin.kind==="peer"）。
 *
 * 链记账语义（SendMessageTool.ts，call() 内联护栏 before-branch 执行）：
 * nextChain = 源 agent 的链 + [源 id]；接收方自引命中数 = 链内等值计数。
 * 主会话（getAgentId 未设）非 peer origin，无链不记账。
 *
 * 注：不直接经 SendMessageTool.call 走路由分支——它依赖的
 * isLocalAgentTask 绑定会被 tests/mocks/localAgentTask 的 process-global
 * mock（last-write-wins）在全量并发跑里特化，链数学单测与上述语义断言
 * 等价且确定性。
 */
import { beforeEach, describe, expect, test } from 'bun:test'

import {
  MAX_CHAIN_LENGTH,
  MAX_SELF_HOPS,
  _resetForwardChainForTest,
  checkForwardHopAdmission,
  countSelfHops,
  forwardChainOf,
  recordForwardChain,
} from '../SendMessageTool.js'

beforeEach(() => {
  _resetForwardChainForTest()
})

describe('官方双口径常量（0258:117）', () => {
  test('maxSelfHops=10 / maxChainLength=28', () => {
    expect(MAX_SELF_HOPS).toBe(10)
    expect(MAX_CHAIN_LENGTH).toBe(28)
  })
})

describe('checkForwardHopAdmission（0258:121 g() 等价）', () => {
  test('链长 > 28 → hop-runaway', () => {
    const longChain = Array.from(
      { length: MAX_CHAIN_LENGTH },
      (_, i) => `agnt_c${i}`,
    )
    expect(longChain).toHaveLength(28)
    expect(
      checkForwardHopAdmission([...longChain, 'agnt_c28'], 'agnt_c29'),
    ).toEqual({ admitted: false, reason: 'hop-runaway' })
    // 恰好 28 不触发链长口径
    expect(checkForwardHopAdmission(longChain, 'agnt_c29').admitted).toBe(true)
  })

  test('接收方自引 ≥ 10 → hop-loop', () => {
    const looping = Array.from({ length: MAX_SELF_HOPS }, () => 'agnt_loop')
    expect(
      checkForwardHopAdmission(['agnt_x', ...looping], 'agnt_loop'),
    ).toEqual({ admitted: false, reason: 'hop-loop' })
    // 9 次自引仍在限内
    expect(
      checkForwardHopAdmission(
        Array.from({ length: MAX_SELF_HOPS - 1 }, () => 'agnt_loop'),
        'agnt_loop',
      ).admitted,
    ).toBe(true)
  })

  test('无自引的正常转发 admits', () => {
    expect(checkForwardHopAdmission(['agnt_a', 'agnt_b'], 'agnt_c')).toEqual({
      admitted: true,
      reason: undefined,
    })
  })

  test('countSelfHops 等值计数（ownTokens ∩ hopChain）', () => {
    expect(countSelfHops(['a', 'b', 'a', 'c', 'a'], 'a')).toBe(3)
    expect(countSelfHops(['a', 'b'], 'c')).toBe(0)
  })
})

describe('链记账（Map 结构，peer 链沿转发上推）', () => {
  test('级联 A1→A2→… 每 hop 链长 +1，第 29 跳 hop-runaway 熔断', () => {
    // 首跳：主会话 → A1（非 peer，不记账，等价 call() 的 getAgentId 未设）
    let sender = 'agnt_hop1'
    let rejectedWith: string | undefined
    for (let hop = 2; hop <= 30; hop++) {
      const target = `agnt_hop${hop}`
      const nextChain = [...forwardChainOf(sender), sender]
      const verdict = checkForwardHopAdmission(nextChain, target)
      if (!verdict.admitted) {
        rejectedWith = verdict.reason
        expect(nextChain).toHaveLength(29)
        break
      }
      recordForwardChain(target, nextChain)
      sender = target
    }
    expect(rejectedWith).toBe('hop-runaway')
  })

  test('二段循环 A↔B 接收方自引单调上推，第 10 次经同 agent 时 hop-loop 熔断', () => {
    // 首跳：主会话 → A（peer-only 记账前的种子链，等价 call() 主会话源不记录）
    recordForwardChain('agnt_ping', ['agnt_main'])
    let sender = 'agnt_ping'
    let rejectedWith: string | undefined
    let hops = 0
    for (let hop = 0; hop < 40; hop++) {
      const target = hop % 2 === 0 ? 'agnt_pong' : 'agnt_ping'
      const nextChain = [...forwardChainOf(sender), sender]
      const verdict = checkForwardHopAdmission(nextChain, target)
      if (!verdict.admitted) {
        rejectedWith = verdict.reason
        break
      }
      recordForwardChain(target, nextChain)
      sender = target
      hops++
    }
    expect(rejectedWith).toBe('hop-loop')
    // A↔B 每轮推高自引 1 → 第 10 次经同 agent（约 19 跳后）熔断
    expect(hops).toBe(19)
  })

  test('主会话来源（getAgentId 未设）无链不记账（仅 peer origin 参检）', () => {
    expect(forwardChainOf(undefined)).toEqual([])
    expect(forwardChainOf('')).toEqual([])
    expect(forwardChainOf('agnt_unknown')).toEqual([])
  })

  test('重复直接转发 A→B 不累积（链记账随接收方，不随发送次数）', () => {
    recordForwardChain('agnt_receiver', ['agnt_sender'])
    for (let i = 0; i < 20; i++) {
      const nextChain = [...forwardChainOf('agnt_sender'), 'agnt_sender']
      expect(nextChain).toEqual(['agnt_sender'])
      expect(
        checkForwardHopAdmission(nextChain, 'agnt_receiver').admitted,
      ).toBe(true)
      recordForwardChain('agnt_receiver', nextChain)
    }
  })

  test('软上限清零防泄漏（256 触发整体重置）', () => {
    for (let i = 0; i < 300; i++) {
      recordForwardChain(`agnt_bulk${i}`, ['agnt_src'])
    }
    // 软上限触发 clear 后整个表归零，后续从空链重新计数（护栏依旧收敛）
    expect(forwardChainOf('agnt_bulk0')).toEqual([])
    recordForwardChain('agnt_after-clear', ['agnt_src'])
    expect(forwardChainOf('agnt_after-clear')).toEqual(['agnt_src'])
  })

  test('_resetForwardChainForTest 清空全部记账', () => {
    recordForwardChain('agnt_r1', ['agnt_main', 'agnt_mid'])
    expect(forwardChainOf('agnt_r1')).toEqual(['agnt_main', 'agnt_mid'])
    _resetForwardChainForTest()
    expect(forwardChainOf('agnt_r1')).toEqual([])
  })
})
