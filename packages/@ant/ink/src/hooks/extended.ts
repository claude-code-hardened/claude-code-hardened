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

/** 官方 Yt：useClock()——ClockProvider 必需（错误契约：useClock must be
 * used within a ClockProvider）；返回 now() 函数。 */
export function useClock(): () => number {
  const nowFn = useContext(ClockContext as never) as (() => number) | undefined
  if (!nowFn) {
    throw new Error('useClock must be used within a ClockProvider')
  }
  return nowFn
}

/** 官方 na：useInputClock()——取当前时钟值（缺省 Date.now）。 */
export function useInputClock(): number {
  const nowFn = useContext(ClockContext as never) as (() => number) | undefined
  return (nowFn ?? Date.now)()
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

/**
 * 官方主题层 Context 的完整字段契约（binary 字符串表实证）：
 *   setThemeSetting / currentTheme / resolvedTheme / activeThemeOverrides /
 *   activeCustomTheme / reloadCustomThemes / setPreviewOverrides /
 *   watchSystemTheme / onThemeSave
 */
export interface ThemeContextContract {
  /** 当前主题 id（toe/useThemeSetting 写入）。 */
  setThemeSetting: (id: string) => void
  /** 当前主题对象。 */
  currentTheme: Record<string, string>
  /** overrides 折叠后的最终值。 */
  resolvedTheme: Record<string, string>
  /** session 级覆盖层。 */
  activeThemeOverrides: ThemeOverride[]
  /** 激活的自定义主题。 */
  activeCustomTheme: ThemeOverride | null
  /** 重新加载用户自定义主题表。 */
  reloadCustomThemes: () => void
  /** 预览覆盖（设置面板实时预览）。 */
  setPreviewOverrides: (o: ThemeOverride | null) => void
  /** 系统主题变化观察（noe）。 */
  watchSystemTheme: (cb: (dark: boolean) => void) => VoidFn
  /** 主题保存回调（onThemeSave）。 */
  onThemeSave: (name: string, values: Record<string, string>) => void
}

const ThemeOverridesContext = useMemoSafe<Partial<ThemeContextContract>>()

export const ThemeOverridesProvider = ThemeOverridesContext.Provider

/** 官方 useActiveThemeOverrides：session 级覆盖层。 */
export function useActiveThemeOverrides(): ThemeOverride[] {
  return useContext(ThemeOverridesContext)?.active ?? []
}

/** 官方 useCustomThemes：用户自定义主题表。 */
export function useCustomThemes(): Record<string, ThemeOverride> {
  return useContext(ThemeOverridesContext)?.custom ?? {}
}

/** 官方 useResolvedTheme：Context 的 resolvedTheme 优先，折叠兜底。 */
export function useResolvedTheme(
  base: Record<string, string>,
): Record<string, string> {
  const ctx = useContext(ThemeOverridesContext)
  const active = useActiveThemeOverrides()
  return useMemo(() => {
    if (ctx?.resolvedTheme) return ctx.resolvedTheme
    const out = { ...base }
    for (const o of active) Object.assign(out, o.values)
    return out
  }, [ctx?.resolvedTheme, base, active])
}

/** 官方 Zn：useTheme()——currentTheme（契约字段）。 */
export function useTheme(): Record<string, string> {
  return useContext(ThemeOverridesContext)?.currentTheme ?? {}
}

/** 官方 toe：useThemeSetting()——主题 id 设置器。 */
export function useThemeSetting(): (id: string) => void {
  return useContext(ThemeOverridesContext)?.setThemeSetting ?? noop
}

/** 官方 dqt：usePreviewTheme()——预览覆盖设置器。 */
export function usePreviewTheme(): (o: ThemeOverride | null) => void {
  return useContext(ThemeOverridesContext)?.setPreviewOverrides ?? noop
}

// ── 树工具（Per / Wbe 原文）──

/** 官方 Per：rootOf(stdout)——instances Map 查已注册 root（createRoot 注册）。 */
export function rootOf(stdout: NodeJS.WriteStream = process.stdout): unknown {
  const registry = require('../core/instances.js') as {
    default: Map<NodeJS.WriteStream, unknown>
  }
  return registry.default.get(stdout)
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
