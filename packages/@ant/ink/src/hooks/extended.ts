import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { AppContext } from '../components/AppContext.js'
import { ClockContext } from '../components/ClockContext.js'
import { ClockSizeFallback } from './clock-fallback.js'

/**
 * 官方 ink hooks 逆向还原（2.1.283 binary @152713000-152720000 区段提取，
 * minified 反混淆）。
 *
 * 混淆名映射（提取区段实证）：
 *   Pe=useContext  E=useRef  se=useCallback  X=useMemo  At=useSyncExternalStore
 *   sn=useLayoutEffect  C=useEffect  RT=useReducer  G_=AppContext
 *   sS=ClockContext  Uvn=ClockNowContext  tN=contains  Vg=行高常量
 *
 * 官方契约要点（与直觉不同的全部标注）：
 *   useFocus()            —— 无参，返回 focusManager 操作集（非 {isFocused}）
 *   useHasFocus(ref)      —— 参数是 ref，返回 activeElement contains(ref) 的布尔
 *   useClock()            —— 返回 now() 函数（非数值）
 *   useMeasured(getSnap)  —— 外部 store 模式（getSnapshot + layoutEffect 兜底）
 *   usePaintedRows(en, r) —— 返回 [ref, rows, lastRows, contentRows] 四元组
 *   useFinePointer(on)    —— 副作用 retain hook（无返回值）
 *   rootOf(stdout)        —— 按 stdout 查已注册 root 实例（非树 parent 链）
 *   topWithin(node, root) —— 两参：累加 computedTop 到 root（offset）
 */

type VoidFn = () => void
const noop: VoidFn = () => {}

// ── 焦点层（Pue / GV 原文）──

export interface FocusManagerApi {
  activeElement: unknown
  focusNext: () => void
  focusPrevious: () => void
  focusDirection: (dir: string) => boolean
  focus: (el: unknown) => void
  blur: () => void
  subscribe: (cb: () => void) => VoidFn
}

/** 官方 Pue：useFocus()——focusManager 操作集（activeElement 经 store 订阅）。 */
export function useFocus(): FocusManagerApi {
  const { focusManager, rootNode } = useContext(AppContext as never) as {
    focusManager?: {
      activeElement?: unknown
      focusNext: (r: unknown) => void
      focusPrevious: (r: unknown) => void
      focusDirection: (d: string, r: unknown) => boolean
      focus: (el: unknown) => void
      blur: () => void
      subscribe: (cb: () => void) => VoidFn
    }
    rootNode?: unknown
  }
  const activeElement = useCallback(
    () => focusManager?.activeElement ?? null,
    [focusManager],
  )
  const subscribe = focusManager?.subscribe ?? noop
  const snap = useSyncExternalStoreShim(subscribe, activeElement)
  return useMemo(
    () => ({
      activeElement: snap,
      focusNext: () => {
        if (focusManager && rootNode) focusManager.focusNext(rootNode)
      },
      focusPrevious: () => {
        if (focusManager && rootNode) focusManager.focusPrevious(rootNode)
      },
      focusDirection: (dir: string) => {
        if (focusManager && rootNode)
          return focusManager.focusDirection(dir, rootNode)
        return false
      },
      focus: (el: unknown) => focusManager?.focus(el),
      blur: () => focusManager?.blur(),
      subscribe,
    }),
    [snap, focusManager, rootNode],
  )
}

/** 官方 GV：useHasFocus(ref)——activeElement 包含 ref.current（树 contains）。 */
export function useHasFocus(ref: { current: unknown }): boolean {
  const { focusManager } = useContext(AppContext as never) as {
    focusManager?: {
      activeElement?: unknown
      subscribe: (cb: () => void) => VoidFn
    }
  }
  const subscribe = focusManager?.subscribe ?? noop
  const getSnapshot = useCallback(() => {
    const el = ref.current
    const active = focusManager?.activeElement
    if (!el || !active) return false
    return contains(active, el)
  }, [ref, focusManager])
  return useSyncExternalStoreShim(subscribe, getSnapshot, () => false)
}

/** core/focus 的 tN 等价：树 contains（parent 链上行）。 */
function contains(ancestor: unknown, node: unknown): boolean {
  let cur = node as { parentNode?: unknown } | null
  while (cur) {
    if (cur === ancestor) return true
    cur = (cur as { parentNode?: unknown }).parentNode ?? null
  }
  return false
}

// ── 时钟层（na / jo / Iue 原文）──

/** 官方 na：useClock()——返回 now() 函数（ClockNow 缺省 Date.now）。 */
export function useClock(): () => number {
  const nowFn = useContext(ClockContext as never) as (() => number) | undefined
  return nowFn ?? Date.now
}

/** 官方 Iue：startClockInterval(store, fn, ms)——自排程循环（finally 重排）。 */
export function startClockInterval(
  store: { setTimeout: (fn: () => void, ms: number) => unknown },
  fn: () => void,
  ms: number,
): VoidFn {
  let stopped = false
  let handle: unknown
  const loop = (): void => {
    if (stopped) return
    try {
      fn()
    } finally {
      if (!stopped) handle = store.setTimeout(loop, ms)
    }
  }
  handle = store.setTimeout(loop, ms)
  return () => {
    stopped = true
  }
}

// ── 测量层（od / Jo/Xi / Nvn 原文）──

/** 官方 od：useMeasured(getSnapshot)——外部 store + layoutEffect 失同步兜底。 */
export function useMeasured<T>(getSnapshot: () => T): T {
  const { subscribeLayout } = useContext(AppContext as never) as {
    subscribeLayout?: (cb: () => void) => VoidFn
  }
  const stored = useSyncExternalStoreShim(subscribeLayout ?? noop, getSnapshot)
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!Object.is(getSnapshot(), stored)) force()
  })
  return stored
}

/** 官方 Jo/Xi：measureElement(node)——yoga 尺寸。 */
export function measureElement(
  node: {
    yogaNode?: { getComputedWidth(): number; getComputedHeight(): number }
  } | null,
): { width: number; height: number } {
  return {
    width: node?.yogaNode?.getComputedWidth() ?? 0,
    height: node?.yogaNode?.getComputedHeight() ?? 0,
  }
}

/** 可视窗口片段（Ko/Qe 滚动裁剪等价）。 */
export interface PaintedWindow {
  first: number
  last: number
  of: number
}

/**
 * 官方 Nvn：usePaintedRows(enabled, rows)——
 * 返回 [ref, rows, lastRows, contentRows]；enabled 时订阅帧同步，
 * rows 为可视窗口（滚动裁剪后），contentRows 为子节点总高。
 */
export function usePaintedRows(
  enabled: boolean,
  rows: PaintedWindow | number | undefined,
): [
  ref: { current: unknown },
  rows: PaintedWindow | number | undefined,
  lastRows: number | undefined,
  contentRows: number | undefined,
] {
  const { subscribeFrames } = useContext(AppContext as never) as {
    subscribeFrames?: (cb: () => void) => VoidFn
  }
  const ref = useRef<unknown>(null)
  const stateRef = useRef<{
    rows: PaintedWindow | number | undefined
    lastRows: number | undefined
    contentRows: number | undefined
  }>({ rows, lastRows: undefined, contentRows: undefined })

  const subscribe = useCallback(
    (cb: () => void) =>
      enabled && subscribeFrames ? subscribeFrames(cb) : noop,
    [enabled, subscribeFrames],
  )
  const getSnapshot = useCallback(() => {
    if (!enabled) return undefined
    const el = ref.current as {
      yogaNode?: { getComputedHeight(): number }
      childNodes?: Array<{ yogaNode?: { getComputedHeight(): number } }>
    } | null
    const frameHeight = el?.yogaNode?.getComputedHeight()
    const contentRows = el?.childNodes?.reduce(
      (sum, k) => sum + (k.yogaNode?.getComputedHeight() ?? 0),
      0,
    )
    const y = stateRef.current
    const rowsChanged = contentRows === undefined || contentRows === y.rows
    const contentChanged = frameHeight === undefined ? undefined : contentRows
    if (!(rowsChanged && contentChanged === y.contentRows)) {
      stateRef.current = {
        rows: rowsChanged ? y.rows : contentRows,
        lastRows: frameHeight ?? y.lastRows,
        contentRows: contentChanged,
      }
    } else if (frameHeight !== undefined) {
      y.lastRows = frameHeight
    }
    return stateRef.current
  }, [enabled])

  const snap = useSyncExternalStoreShim(subscribe, getSnapshot)
  return [ref, snap?.rows, snap?.lastRows, snap?.contentRows]
}

// ── 终端能力（Dvn 原文）──

/** 官方 Dvn：useFinePointer(enabled)——副作用 retain（无返回值）。 */
export function useFinePointer(enabled: boolean): void {
  const { retainFinePointer } = useContext(AppContext as never) as {
    retainFinePointer?: () => VoidFn
  }
  useEffect(() => {
    if (!enabled) return undefined
    return retainFinePointer?.()
  }, [enabled, retainFinePointer])
}

// ── 主题三层（语境还原：Provider 上下文折叠）──

export interface ThemeOverride {
  name: string
  values: Record<string, string>
}

const ThemeOverridesContext = useMemoSafe<{
  active: ThemeOverride[]
  custom: Record<string, ThemeOverride>
}>()

export const ThemeOverridesProvider = ThemeOverridesContext.Provider

/** 官方 useActiveThemeOverrides：session 级覆盖层。 */
export function useActiveThemeOverrides(): ThemeOverride[] {
  return useContext(ThemeOverridesContext)?.active ?? []
}

/** 官方 useCustomThemes：用户自定义主题表。 */
export function useCustomThemes(): Record<string, ThemeOverride> {
  return useContext(ThemeOverridesContext)?.custom ?? {}
}

/** 官方 useResolvedTheme：overrides 折叠后的最终值。 */
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

// ── 树工具（Per / Wbe 原文）──

/** 官方 Per：rootOf(stdout)——instances WeakMap 查已注册 root。 */
export function rootOf(stdout: NodeJS.WriteStream = process.stdout): unknown {
  const instances = require('../core/instances.js') as {
    get: (s: NodeJS.WriteStream) => { root?: unknown } | undefined
  }
  const inst = instances.get(stdout)
  return inst?.root
}

/** 官方 Wbe：topWithin(node, root)——累加 computedTop 到 root（rootOff）。 */
export function topWithin(
  node: {
    yogaNode?: { getComputedTop(): number }
    parentNode?: unknown
  } | null,
  root: unknown,
): number {
  let offset = 0
  let cur = node
  while (cur !== undefined && cur !== root) {
    offset += cur.yogaNode?.getComputedTop() ?? 0
    cur = (cur as { parentNode?: unknown }).parentNode as typeof cur
  }
  return cur === root ? offset : -1
}

// ── useSyncExternalStore 兼容 shim（react 版本差异隔离）──

function useSyncExternalStoreShim<T>(
  subscribe: (cb: () => void) => VoidFn,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T {
  const React = require('react') as {
    useSyncExternalStore?: (
      s: (cb: () => void) => VoidFn,
      g: () => T,
      gs?: () => T,
    ) => T
  }
  if (React.useSyncExternalStore) {
    return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  }
  const [_, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => subscribe(force), [subscribe])
  return getSnapshot()
}

// ── 屏幕阅读器（官方导出面；env 惯例标记）──

/** 官方 useIsScreenReaderEnabled：STDIN 屏幕阅读器标记。 */
export function useIsScreenReaderEnabled(): boolean {
  const [enabled] = useState(
    () => process.env['CLAUDE_CODE_SCREEN_READER'] === '1',
  )
  return enabled
}

function useMemoSafe<T>(): React.Context<T | undefined> {
  return require('react').createContext<T | undefined>(undefined)
}

void ClockSizeFallback
