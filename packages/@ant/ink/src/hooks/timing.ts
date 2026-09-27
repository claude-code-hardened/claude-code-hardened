import { useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { AppContext } from '../components/AppContext.js'
import { ClockContext } from '../components/ClockContext.js'

/**
 * 官方 cB / Mvn / Ea / _r（binary @152712805-152716480 区段）——
 * 防抖回调 / 动画计时器 / 帧对齐 / 超时（函数·数值双态重载）。
 * 反混淆映射：Pe=useContext E=useRef se=useCallback X=useMemo
 * At=useSyncExternalStore C=useEffect sS=ClockContext hP=setTimeout 兜底
 */

type VoidFn = () => void
const noop: VoidFn = () => {}

// ── 官方 cB：useDebouncedCallback(fn, ms) ──

export interface Cancelable<Args extends unknown[]> {
  (...args: Args): void
  cancel: () => void
}

/** 官方 cB 原文：尾沿防抖 + .cancel；timer 用 AppContext 的 setTimeout（可注入）。 */
export function useDebouncedCallback<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number,
): Cancelable<Args> {
  const { setTimeout: ctxSetTimeout } = useContext(AppContext as never) as {
    setTimeout?: (fn: () => void, ms: number) => unknown
  }
  const fnRef = useRef(fn)
  fnRef.current = fn
  const timerRef = useRef<VoidFn | null>(null)
  const scheduleRef = useRef<((cb: () => void) => VoidFn) | null>(null)
  const clear = useCallback((): VoidFn => () => timerRef.current?.(), [])

  const setTimeoutFn =
    ctxSetTimeout ??
    ((cb: () => void, delay: number) => {
      const t = setTimeout(cb, delay)
      return () => clearTimeout(t)
    })

  const debounced = useMemo(() => {
    const call = (...args: Args): void => {
      timerRef.current?.()
      timerRef.current = setTimeoutFn(() => {
        timerRef.current = null
        fnRef.current(...args)
      }, ms) as VoidFn
    }
    ;(call as Cancelable<Args>).cancel = () => {
      timerRef.current?.()
      timerRef.current = null
    }
    return call as Cancelable<Args>
  }, [setTimeoutFn, ms])

  void scheduleRef
  void clear
  return debounced
}

// ── 官方 Mvn：useAnimationTimer(fps) ──

/**
 * 官方 Mvn 原文：帧对齐计时——`Math.ceil(fps/行高)*行高` 分片，
 * 订阅 subscribeFollower；返回自上次对齐点起算的整数 tick。
 */
export function useAnimationTimer(fps: number | null): number {
  const clock = useContext(ClockContext as never) as
    | {
        subscribeFollower?: (cb: () => void) => VoidFn
        now: () => number
      }
    | undefined
  const slice = fps === null ? null : Math.ceil(fps)
  const anchorRef = useRef<number | null>(null)

  const subscribe = useMemo(() => {
    if (!clock || slice === null) return noop
    return (cb: () => void) =>
      clock.subscribeFollower?.(() => {
        anchorRef.current = clock.now()
        cb()
      }) ?? noop
  }, [clock, slice])

  const [, force] = useReducerShim()
  useEffect(() => {
    const un = subscribe(force)
    return un
  }, [subscribe])

  if (!clock || slice === null) return 0
  if (anchorRef.current === null) anchorRef.current = clock.now()
  return Math.floor(anchorRef.current / slice) * slice
}

// ── 官方 Ea：useAnimationFrameEx(fps)（映射实证：Ea as useAnimationFrame）──

/** 官方 Ce：alt-screen 全量重绘阈值（CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT 时下限 480）。 */
export function repaintFloor(fps: number): number {
  const fullRepaint = process.env['CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT'] === '1'
  return fullRepaint ? Math.max(fps, 480) : fps
}

/**
 * 官方 Ea 原文：useFrames(fps)——返回 [visibility, tick]。
 * visibility 来自 useInView；tick 以 repaintFloor(fps) 帧对齐，
 * 仅在可见时推进 keepAlive 订阅。
 */
export function useAnimationFrameEx(
  fps: number | null = 16,
  inView:
    | [
        setRef: (n: unknown) => void,
        isVisible: boolean,
        forceCheck: () => boolean,
        compute: () => boolean,
      ]
    | null = null,
): [(node: unknown) => void, number] {
  const clock = useContext(ClockContext as never) as
    | {
        subscribeKeepAlive?: (cb: () => void) => VoidFn
        now: () => number
      }
    | undefined
  const [, isVisible, , compute] = inView ?? [noop, true, noop, () => true]
  const floor = fps === null ? null : Math.ceil(repaintFloor(fps))

  const subscribe = useMemo(() => {
    if (!clock || floor === null) return noop
    return (cb: () => void) => clock.subscribeKeepAlive?.(cb) ?? noop
  }, [clock, floor])

  const tickRef = useRef(0)
  const [, force] = useReducerShim()
  const getSnapshot = useCallback(() => {
    if (!clock || floor === null) return 0
    return (tickRef.current = Math.max(
      tickRef.current,
      Math.floor(clock.now() / floor) * floor,
    ))
  }, [clock, floor])

  const tick = useSyncExternalStoreShim2(
    isVisible ? subscribe : noop,
    getSnapshot,
  )
  void compute
  void force
  return [noop as unknown as (node: unknown) => void, tick]
}

// ── 官方 _r：useTimeout（函数·数值双态重载）──

/**
 * 官方 _r 原文：useTimeout(fn, delay) —— fn 为函数时返回 void（内部状态），
 * delay 为函数时返回「是否已到期」的布尔（useSyncExternalStore）。
 * 支持 deps 数组（l??[]）重排计时器。
 */
export function useTimeout(fn: VoidFn, delay: number, deps?: unknown[]): void
export function useTimeout(delay: number, deps?: unknown[]): boolean
export function useTimeout(
  a: VoidFn | number,
  b?: number | unknown[],
  c?: unknown[],
): boolean | undefined {
  const ctx = useContext(AppContext as never) as {
    setTimeout?: (fn: () => void, ms: number) => unknown
  }
  const setTimeoutFn =
    ctx.setTimeout ??
    ((cb: () => void, delay: number) => {
      const t = setTimeout(cb, delay)
      return () => clearTimeout(t)
    })
  const isFnForm = typeof a === 'function'
  const fnRef = useRef<VoidFn | null>(isFnForm ? (a as VoidFn) : null)
  fnRef.current = isFnForm ? (a as VoidFn) : null
  const delayValue = (isFnForm ? (b as number) : (a as number)) ?? null
  const depsList = isFnForm
    ? (c as unknown[] | undefined)
    : (b as unknown[] | undefined)
  const firedRef = useRef<VoidFn | null>(null)

  const subscribe = useMemo(() => {
    if (delayValue === null) return noop
    return (cb: () => void) => {
      firedRef.current = () => {
        firedRef.current = null
        cb()
        setTimeoutFn(() => {
          if (isFnForm) fnRef.current?.()
          else cb()
        }, delayValue)
      }
      return firedRef.current
    }
  }, [setTimeoutFn, delayValue, isFnForm, depsList])

  const getSnapshot = useCallback(
    () => (delayValue === null ? null : firedRef.current === subscribe),
    [delayValue, subscribe],
  )
  const expired = useSyncExternalStoreShim2(
    subscribe,
    getSnapshot as () => boolean,
  )

  return isFnForm ? undefined : expired
}

// ── shims ──

function useReducerShim(): [number, VoidFn] {
  const React = require('react') as {
    useReducer: (r: (n: number) => number, i: number) => [number, VoidFn]
  }
  return React.useReducer((n: number) => n + 1, 0)
}

function useSyncExternalStoreShim2<T>(
  subscribe: VoidFn,
  getSnapshot: () => T,
): T {
  const React = require('react') as {
    useSyncExternalStore?: (s: (cb: () => void) => VoidFn, g: () => T) => T
    useState: (i: T) => [T, (v: T) => void]
    useEffect: (f: () => VoidFn, d?: unknown[]) => void
    useReducer: (r: (n: number) => number, i: number) => [number, VoidFn]
  }
  if (React.useSyncExternalStore) {
    return React.useSyncExternalStore(subscribe, getSnapshot)
  }
  const [, force] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => subscribe(), [subscribe])
  return getSnapshot()
}
