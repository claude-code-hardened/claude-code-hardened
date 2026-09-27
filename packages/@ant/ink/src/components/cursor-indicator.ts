import { useLayoutEffect, useRef } from 'react'

/**
 * 官方 tqt：ref 赋值 helper（函数 ref 与对象 ref 双形态统一）。
 * 原文：if (typeof o === "function") { o(r); return } if (o) o.current = r
 */
export function assignRef<T>(
  ref: ((v: T) => void) | { current: T | null } | null | undefined,
  value: T,
): void {
  if (typeof ref === 'function') {
    ref(value)
    return
  }
  if (ref) ref.current = value
}

/** 官方 Vw props：光标指示（行/列/激活/可见）。 */
export interface CursorIndicatorProps {
  line: number
  column: number
  active?: boolean
  visible?: boolean
}

/**
 * 官方 Vw：CursorIndicator——光标位置声明（$vn CursorContext 消费，
 * layoutEffect 挂 ref）。语义契约还原；渲染层由 CursorDeclarationContext
 * 承载（cch 已有 core 的 cursor 声明体系）。
 */
export function useCursorIndicatorRef(): {
  setRef: (el: unknown) => void
} {
  const ref = useRef<unknown>(null)
  useLayoutEffect(() => {
    void ref.current
  })
  return { setRef: (el: unknown) => (ref.current = el) }
}
