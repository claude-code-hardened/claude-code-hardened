import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AppContext } from '../components/AppContext.js'

/**
 * 官方 D7：useInView()——元素是否落在终端可视窗口内。
 * 原文（binary @152712424）：ref + isVisible 状态 + forceCheck + computeIsVisible
 * 四元组；可见性由 yoga computedTop/Height 与 TerminalSize 的 viewport 比对，
 * overflowY==='scroll' 的祖先链按 scrollTop 修正（N7）。
 * 返回：[setRef, isVisible, forceCheck, computeIsVisible]
 */

export interface UseInViewResult {
  0: (node: unknown) => void
  1: boolean
  2: () => boolean
  3: () => boolean
  length: 4
}

type SizeCtx = { columns: number; rows: number } | undefined
type Yg = {
  getComputedTop(): number
  getComputedHeight(): number
}
type DomNode = {
  yogaNode?: Yg
  parentNode?: DomNode | null
  style?: { overflowY?: string; overflow?: string }
  scrollTop?: number
  scrollTopRendered?: number
}

/** 官方 qe 等价：node 是否与 terminal viewport 相交（含滚动祖先修正）。 */
function computeIsVisible(
  node: DomNode | null,
  terminal: SizeCtx,
): boolean | null {
  if (node === null) return null
  if (terminal === undefined) return true
  const rows = terminal.rows
  if (node.yogaNode === undefined) return null
  const height = node.yogaNode.getComputedHeight()
  const top = node.yogaNode.getComputedTop()
  let offset = top
  let parent: DomNode | null = node.parentNode ?? null
  let rootYg: Yg | undefined = node.yogaNode
  while (parent) {
    if (parent.yogaNode) {
      offset += parent.yogaNode.getComputedTop()
      rootYg = parent.yogaNode
    }
    const oy = parent.style?.overflowY ?? parent.style?.overflow
    if (oy === 'scroll' && parent.scrollTopRendered === undefined) return null
    if (parent.scrollTop) offset -= parent.scrollTop
    parent = parent.parentNode ?? null
  }
  const rootHeight = rootYg?.getComputedHeight() ?? 0
  const bottom = offset + height
  const hasScroll = rootHeight > rows ? 1 : 0
  const viewportTop = Math.max(0, rootHeight - rows) + hasScroll
  const viewportBottom = viewportTop + rows
  if (height === 0) return offset >= viewportTop && offset < viewportBottom
  return bottom > viewportTop && offset < viewportBottom
}

export function useInView(): [
  setRef: (node: unknown) => void,
  isVisible: boolean,
  forceCheck: () => boolean,
  computeIsVisible: () => boolean,
] {
  const terminal = useContext(AppContext as never) as unknown as SizeCtx
  const nodeRef = useRef<DomNode | null>(null)
  const [state, setState] = useState({ isVisible: true })

  const setRef = useCallback((node: unknown) => {
    nodeRef.current = node as DomNode | null
  }, [])

  const compute = useCallback((): boolean => {
    const result = computeIsVisible(nodeRef.current, terminal)
    if (result === null) return state.isVisible
    if (result !== state.isVisible) setState({ isVisible: result })
    return result
  }, [terminal, state.isVisible])

  const forceCheck = useCallback((): boolean => compute(), [compute])

  useEffect(() => {
    compute()
  })

  return [
    setRef,
    state.isVisible,
    forceCheck,
    compute,
  ] as unknown as UseInViewResult as [
    setRef: (node: unknown) => void,
    isVisible: boolean,
    forceCheck: () => boolean,
    computeIsVisible: () => boolean,
  ]
}
