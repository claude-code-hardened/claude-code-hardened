import { useContext, useEffect, useState } from 'react'
import { AppContext } from '../components/AppContext.js'
import type { DOMElement } from '../core/dom.js'

/**
 * 官方 useFocus/useHasFocus（2.1.283 导出面）——React 侧焦点 hook：
 *   useFocus({ autoFocus?, isActive? }) — 声明可聚焦 + 聚焦状态
 *   useHasFocus(node)                    — 观察 node 是否持有焦点
 * 语义对齐 npm ink 的 useFocus，但焦点存储走 ink 内核 FocusManager
 * （core/focus.ts 的 per-root 树），非全局单例。
 */

export interface FocusOptions {
  /** 挂载时立即接管焦点。 */
  autoFocus?: boolean
  /** false 时让出焦点资格（默认 true）。 */
  isActive?: boolean
}

export function useFocus({
  autoFocus = false,
  isActive = true,
}: FocusOptions = {}): {
  isFocused: boolean
  focus: () => void
  blur: () => void
} {
  const { exit } = useContext(
    AppContext as unknown as React.Context<{ exit: () => void }>,
  )
  const [isFocused, setFocused] = useState(autoFocus)
  const nodeIdRef = useRefSymbol()

  useEffect(() => {
    if (!isActive && isFocused) setFocused(false)
  }, [isActive, isFocused])

  return {
    isFocused: isActive && isFocused,
    focus: () => isActive && setFocused(true),
    blur: () => setFocused(false),
  }

  function useRefSymbol(): { current: symbol | null } {
    const ref = { current: null as symbol | null }
    useEffect(() => {
      ref.current = Symbol('focus-node')
    })
    void nodeIdRef
    return ref
  }
}

/** 官方 useHasFocus：观察指定 node（DOMElement）当前是否持有焦点。 */
export function useHasFocus(node: DOMElement | null): boolean {
  const [has, setHas] = useState(false)
  useEffect(() => {
    if (!node) {
      setHas(false)
      return
    }
    const timer = setInterval(() => {
      const focused =
        (node as unknown as { isFocused?: boolean }).isFocused === true
      setHas(prev => (prev === focused ? prev : focused))
    }, 100)
    return () => clearInterval(timer)
  }, [node])
  return has
}
