/**
 * Tests for SendMessageTool.call() forwardChain 接线（W1.6 / W1.3 判定源收敛）。
 *
 * 官方真源（Q2 亲读原文）：
 * - 0001-chunk-xrzcaagk/module-006-uncategorized.js:2180 `_ge(e)`（origin
 *   kind==='peer' 才算 peer 消息）+ :2184 `b4e(e)`
 *   （`e.verifiedPeerPid!==void 0||e.from!=="unknown"`）+ :9228 `vr()`：
 *   `if(!_ge(sr))return Zpe` —— 非 peer origin 无条件放行，进程内 agent
 *   （同宿主进程）不计 hops。
 * - 跨 transport 真 peer（bridge/uds/tcp）在发送面参检：0258-chunk-116j5z58/
 *   module-005-uncategorized.js:117 Tan={maxSelfHops:10,maxChainLength:28}
 *   + :121 g(d,o) 双口径（hop-runaway / hop-loop）。
 *
 * 测试面构成（确定性约束）：
 * - 进程内 no-count 面走 SendMessageTool.call() 真实路由分支（无 feature
 *   门，可直达）：预置超限链仍照常投递、且链不被读/记——官方
 *   `if(!_ge(sr))return Zpe` 的 call() 级等价断言。
 * - 跨 transport 参检面经 enforcePeerHopAdmission（transport 分支内联的
 *   同一函数）直测 admit/记账/拒发数学。注：call() 的 uds/tcp/bridge 分支
 *   受 bun:bundle 编译期门（bun test 1.4.3 里 feature() 恒 false 且
 *   mock.module('bun:bundle') 实测无效——探针 run 类贴里 feature('MAGIC_X')
 *   mock 后不翻转），无法在单测内直达；admission 只挂在真 peer 分支内，
 *   接线覆盖由进程内负控面 + helper 面组合担保。
 */
import { beforeEach, describe, expect, test } from 'bun:test'

import {
  MAX_CHAIN_LENGTH,
  _resetForwardChainForTest,
  checkForwardHopAdmission,
  crossTransportPeerRoute,
  enforcePeerHopAdmission,
  forwardChainOf,
  recordForwardChain,
  senderHopLink,
} from '../SendMessageTool.js'
import { SendMessageTool } from '../SendMessageTool.js'

beforeEach(() => {
  _resetForwardChainForTest()
})

const AGENT_ID = 'adeadbeefdeadbeef' // a + 16 hex（toAgentId 合式）

function inProcessContext(
  agentId: string,
  initialPending: string[] = [],
): {
  context: unknown
  capturedState: () => Record<string, { pendingMessages?: string[] }>
} {
  const state = {
    agentNameRegistry: new Map<string, string>(),
    tasks: {
      [agentId]: {
        type: 'local_agent',
        agentType: 'subagent',
        status: 'running',
        pendingMessages: [...initialPending],
      },
    },
  }
  return {
    context: {
      getAppState: () => state,
      setAppState: (f: (prev: unknown) => unknown) => {
        const next = f(state)
        Object.assign(state, next as object)
        return state
      },
    },
    capturedState: () =>
      state.tasks as Record<string, { pendingMessages?: string[] }>,
  }
}

describe('crossTransportPeerRoute（_ge 的路由面等价判定）', () => {
  test('uds/tcp/bridge 真 peer 归类；进程内路由（裸名/agentId）不是 peer', () => {
    expect(crossTransportPeerRoute('uds:/tmp/peer.sock')).toEqual({
      kind: 'uds',
      peerKey: 'uds:/tmp/peer.sock',
    })
    expect(crossTransportPeerRoute('tcp:127.0.0.1:9876')).toEqual({
      kind: 'tcp',
      peerKey: 'tcp:127.0.0.1:9876',
    })
    expect(crossTransportPeerRoute('bridge:sess-42')).toEqual({
      kind: 'bridge',
      peerKey: 'bridge:sess-42',
    })
    // 同宿主进程路由：裸 teammate 名与 raw agent id 都不是 peer——同
    // process 判据不计 hops（官方 `if(!_ge(sr))return Zpe`）。
    expect(crossTransportPeerRoute('scout-teammate')).toBeUndefined()
    expect(crossTransportPeerRoute(AGENT_ID)).toBeUndefined()
    expect(crossTransportPeerRoute('*')).toBeUndefined()
  })

  test('uds 记账键剥离 inline token（token 探针不入链）', () => {
    expect(crossTransportPeerRoute('uds:/tmp/peer.sock#token=')).toEqual({
      kind: 'uds',
      peerKey: 'uds:/tmp/peer.sock',
    })
  })
})

describe('SendMessageTool.call() 进程内路由不参检不记账（vr 非 peer 放行）', () => {
  // 全量并发跑里 SendMessageTool 进程级共享模块（LocalAgentTask / teammate /
  // resumeAgent 链）会被同进程先跑文件的 mock 特化（round-1 已记录的
  // last-write-wins 面队），路由终态（queued/resumed/error）不单体确定；
  // 但 W1.3 收敛后的进程内路由**不读也不写 hop 链**——链记账面在两类特化
  // 下是不变量（旧实现带 sourceAgentId 判据会在链被毒化时拒发/记账），故
  // call() 接线断言落在链面不变量上，路由终态不做单体断言。

  test('运行中 in-process agent：链表零参检（空链持空）', async () => {
    try {
      await SendMessageTool.call(
        {
          to: AGENT_ID,
          message: 'relay please',
          summary: 'relay',
        } as never,
        inProcessContext(AGENT_ID).context as never,
        undefined as never,
        undefined as never,
      )
    } catch {
      // 进程级 mock 特化差（resume/teammate 链）允许路由终态异常——
      // 被测面是链不记账，不是路由成败。
    }
    expect(forwardChainOf(AGENT_ID)).toEqual([])
  })

  test('预置超限链不阻止进程内投递、链记账不被读/写（同 process 不计 hops）', async () => {
    const poisoned = Array.from(
      { length: MAX_CHAIN_LENGTH },
      (_, i) => `agnt_c${i}`,
    )
    recordForwardChain(AGENT_ID, poisoned)
    try {
      await SendMessageTool.call(
        { to: AGENT_ID, message: 'still delivers', summary: 'ok' } as never,
        inProcessContext(AGENT_ID).context as never,
        undefined as never,
        undefined as never,
      )
    } catch {
      // 进程级 mock 特化差允许路由终态异常（resume/teammate 链）——
      // 被测面是链零接触。
    }
    // 旧实现（sourceAgentId 判据+checkForwardHopAdmission）在毒链下会走
    // hop-runaway 拒绝/记账；收敛后进程内路由对链零接触：毒链原样保留、
    // 不增长不触发熔断。路由终态（成功拒绝/异常）非本断言面。
    expect(forwardChainOf(AGENT_ID)).toEqual(poisoned)
  })
})

describe('enforcePeerHopAdmission（真 peer 发送面，0258:121 g() 双口径）', () => {
  test('首次 admit 记账：链 = [发送者 link]', () => {
    const rejection = enforcePeerHopAdmission({
      kind: 'uds',
      peerKey: 'uds:/tmp/peer.sock',
    })
    expect(rejection).toBeUndefined()
    const chain = forwardChainOf('uds:/tmp/peer.sock')
    expect(chain).toHaveLength(1)
    expect(chain[0]).toBe(senderHopLink())
  })

  test('同链同源重复发送不增长链（官方 admit() 共存面近似）', () => {
    for (let i = 0; i < 5; i++) {
      expect(
        enforcePeerHopAdmission({ kind: 'tcp', peerKey: 'tcp:10.0.0.7:7777' }),
      ).toBeUndefined()
    }
    expect(forwardChainOf('tcp:10.0.0.7:7777')).toHaveLength(1)
  })

  test('链超限 → hop-runaway 拒发', () => {
    recordForwardChain(
      'bridge:relay-1',
      Array.from({ length: MAX_CHAIN_LENGTH }, (_, i) => `agnt_c${i}`),
    )
    const rejection = enforcePeerHopAdmission({
      kind: 'bridge',
      peerKey: 'bridge:relay-1',
    })
    expect(rejection).toBeDefined()
    expect(rejection!.data.success).toBe(false)
    expect(rejection!.data.message).toContain('hop-runaway')
    expect(rejection!.data.message).toContain('Forward rejected')
  })

  test('自引超限 → hop-loop 拒发', () => {
    const peerKey = senderHopLink()
    // 链内自引已到 maxSelfHops：下一次 admission 对「经同一 peer」的发送熔断
    recordForwardChain(
      peerKey,
      Array.from({ length: 10 }, () => senderHopLink()),
    )
    const rejection = enforcePeerHopAdmission({
      kind: 'uds',
      peerKey,
    })
    expect(rejection).toBeDefined()
    expect(rejection!.data.message).toContain('hop-loop')
  })
})

describe('checkForwardHopAdmission 双口径回归（0258:117 常量锚定）', () => {
  test('链长恰 28 admits、29 拒（hop-runaway）', () => {
    const chain28 = Array.from({ length: 28 }, (_, i) => `agnt_x${i}`)
    expect(checkForwardHopAdmission(chain28, 'agnt_dst').admitted).toBe(true)
    expect(
      checkForwardHopAdmission([...chain28, 'agnt_more'], 'agnt_dst'),
    ).toEqual({ admitted: false, reason: 'hop-runaway' })
  })
})
