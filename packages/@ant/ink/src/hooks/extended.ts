import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  useEffect,
  type ReactNode,
} from 'react'
import { ClockContext } from '../components/ClockContext.js'
import { StdinContext } from '../components/StdinContext.js'

/**
 * 官方 ink 领先面补齐（2.1.283 导出面考古）——语义按官方 API 契约实现：
 *   useClock/useInputClock/startClockInterval —— 时钟层（ClockContext 消费）
 *   useMeasured/usePaintedRows —— yoga 测量与已绘行数
 *   useFinePointer/useIsScreenReaderEnabled —— 终端能力探测
 *   useActiveThemeOverrides/useCustomThemes/useResolvedTheme —— 主题三层
 *   topWithin/rootOf —— 节点树工具（core/root 协作）
 */

// ── 时钟层 ──

export function useClock(): number {
  const ctx = useContext(
    ClockContext as unknown as React.Context<{ now: number } | undefined>,
  )
  return ctx?.now ?? 0
}

export function useInputClock(): number {
  const ctx = useContext(
    ClockContext as unknown as React.Context<{ inputNow: number } | undefined>,
  )
  return ctx?.inputNow ?? 0
}

/** 全局时钟推进器（ClockProvider 之外的独立宿主用）。 */
export function startClockInterval(
  ms: number,
  tick: (now: number) => void,
): () => void {
  const timer = setInterval(() => tick(Date.now()), ms)
  return () => clearInterval(timer)
}

// ── 测量层 ──

/** useMeasured：元素 yoga 尺寸（refs + getComputedWidth/Height）。 */
export function useMeasured<T extends Element>(): {
  ref: React.RefObject<T | null>
  width: number
  height: number
} {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current as unknown as {
      yogaNode?: { getComputedWidth(): number; getComputedHeight(): number }
    } | null
    if (!el?.yogaNode) return
    const w = el.yogaNode.getComputedWidth()
    const h = el.yogaNode.getComputedHeight()
    setSize(prev =>
      prev.width === w && prev.height === h ? prev : { width: w, height: h },
    )
  })
  return { ref, ...size }
}

/** usePaintedRows：上一帧实际绘制的行数（output 高度 / viewport）。 */
export function usePaintedRows(rowsRef: { current: number }): number {
  const [, force] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => force(n => n + 1), 250)
    return () => clearInterval(timer)
  }, [])
  return rowsRef.current
}

// ── 终端能力 ──

/** useFinePointer：鼠标精细指针支持（SGR mouse / xterm 1006）。 */
export function useFinePointer(): boolean {
  const { isRawModeSupported } = useContext(
    StdinContext as unknown as React.Context<{ isRawModeSupported?: boolean }>,
  )
  return isRawModeSupported === true
}

/** useIsScreenReaderEnabled：STDIN 屏幕阅读器标记（CLAUDE_CODE_SCREEN_READER 惯例）。 */
export function useIsScreenReaderEnabled(): boolean {
  const [enabled] = useState(
    () => process.env['CLAUDE_CODE_SCREEN_READER'] === '1',
  )
  return enabled
}

// ── 主题三层 ──

export interface ThemeOverride {
  name: string
  values: Record<string, string>
}

const ThemeOverridesContext = createContext<
  { active: ThemeOverride[]; custom: Record<string, ThemeOverride> } | undefined
>(undefined)

export const ThemeOverridesProvider = ThemeOverridesContext.Provider

/** 官方 useActiveThemeOverrides：当前生效的覆盖层（用户 session 级）。 */
export function useActiveThemeOverrides(): ThemeOverride[] {
  return useContext(ThemeOverridesContext)?.active ?? []
}

/** 官方 useCustomThemes：用户自定义主题表。 */
export function useCustomThemes(): Record<string, ThemeOverride> {
  return useContext(ThemeOverridesContext)?.custom ?? {}
}

/** 官方 useResolvedTheme：overrides 折叠后的最终主题值。 */
export function useResolvedTheme(
  base: Record<string, string>,
): Record<string, string> {
  const active = useActiveThemeOverrides()
  return useMemo(() => {
    const out = { ...base }
    for (const o of active) Object.assign(out, o.values)
    return out
  }, [base, active])
}

// ── 树工具 ──

/** 官方 rootOf：沿 parent 链找根节点。 */
export function rootOf(node: { parent?: unknown } | null): unknown {
  let cur = node
  while (cur && (cur as { parent?: unknown }).parent)
    cur = (cur as { parent?: unknown }).parent
  return cur
}

/** 官方 topWithin：node 在其父容器内的 z 序顶部检查（兄弟链最后者）。 */
export function topWithin(
  node: { parent?: { children?: unknown[] } } | null,
): boolean {
  const parent = node?.parent
  if (!parent?.children) return true
  const last = parent.children[parent.children.length - 1]
  return last === node
}
