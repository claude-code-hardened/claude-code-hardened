/**
 * IntelliJ（JediTerm）滚轮 bug 修正层——官方 F9r 完整逆向还原
 * （binary @148952066-148954187 区段）。
 *
 * 两个 bug：
 *   ① wheelup 被终端反转上报 → bug 已确认时改写为 wheeldown
 *      （条件：wheelup 且距上次 wheeldown < 250ms 且 bugConfirmed）
 *   ② 键盘箭头（纯 up/down，无修饰键）被当滚轮 → 75ms 内的 up/down 丢弃
 *      并一次性通知用户（IntelliJ 命令块环境自动确认 bug）
 *
 * 混淆名映射（原文）：r=state n=inputs o=now u=notify
 *   le=75(键判窗) de=250(wheel 反转窗) Ker=200(重置窗)
 *   ue=confirm h=reset qer=bugConfirmed tN 见 focus
 */

export interface JediTermWheelState {
  lastWheelTime: number
  lastWheelDownTime: number
  bugConfirmed: boolean
  notified: boolean
  trackpadGesture: boolean
  pendingArrowBoost: number
}

export interface WheelInput {
  kind: string
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}

/** 官方 YJe：wheel bug 状态工厂。 */
export function createJediTermWheelState(): JediTermWheelState {
  return {
    lastWheelTime: 0,
    lastWheelDownTime: 0,
    bugConfirmed: false,
    notified: false,
    trackpadGesture: false,
    pendingArrowBoost: 0,
  }
}

/** 官方 ue：确认 bug（trackpad 手势 + boost 计数）。 */
export function confirmBug(state: JediTermWheelState): void {
  state.bugConfirmed = true
  state.trackpadGesture = true
  state.pendingArrowBoost++
}

/** 官方 h：重置 trackpad 状态（保留 bugConfirmed/pendingArrowBoost 语义分离）。 */
export function resetTrackpad(state: JediTermWheelState): void {
  state.trackpadGesture = false
  state.pendingArrowBoost = 0
}

/** 官方 L9r：取走 pendingArrowBoost（消费即清零）。 */
export function takePendingBoost(state: JediTermWheelState): number {
  const n = state.pendingArrowBoost
  state.pendingArrowBoost = 0
  return n
}

/** 官方 qer：bug 是否已确认（IntelliJ 命令块环境变量直接确认）。 */
export function isBugConfirmed(state: JediTermWheelState): boolean {
  if (state.bugConfirmed) return true
  if (
    process.env['INTELLIJ_TERMINAL_COMMAND_BLOCKS_REWORKED'] !== undefined ||
    process.env['INTELLIJ_TERMINAL_COMMAND_BLOCKS'] !== undefined
  ) {
    state.bugConfirmed = true
    return true
  }
  return false
}

const KEY_WINDOW_MS = 75
const WHEEL_FLIP_MS = 250
const RESET_WINDOW_MS = 200

type JetBrainsDetector = () => { jediTerm?: boolean }

/**
 * 官方 F9r：滚轮 bug 修正主函数——修正后的输入数组（无修改时原样返回）。
 *
 * @param state     wheel bug 状态（可变，跨调用保持）
 * @param inputs    输入事件数组
 * @param now       当前时间戳
 * @param notify    一次性用户通知回调（bug 首次确认时调用）
 * @param detector  JetBrains/JediTerm 环境检测（注入）
 */
export function fixJediTermWheel<T extends WheelInput>(
  state: JediTermWheelState,
  inputs: T[],
  now: number,
  notify: () => void,
  detector: JetBrainsDetector,
): T[] {
  if (!detector().jediTerm) {
    resetTrackpad(state)
    return inputs
  }
  let patched: T[] | null = null
  for (let p = 0; p < inputs.length; p++) {
    const evt = inputs[p]!
    if (evt.kind !== 'key') {
      patched?.push(evt)
      continue
    }
    if (evt.name === 'wheelup' || evt.name === 'wheeldown') {
      if (now - state.lastWheelTime > RESET_WINDOW_MS) {
        state.lastWheelDownTime = 0
        resetTrackpad(state)
      }
      state.lastWheelTime = now
      if (evt.name === 'wheeldown') state.lastWheelTime = now
      // ① 方向反转修正：wheelup 改写为 wheeldown
      if (
        evt.name === 'wheelup' &&
        now - state.lastWheelDownTime < WHEEL_FLIP_MS &&
        isBugConfirmed(state)
      ) {
        patched ??= inputs.slice(0, p)
        patched.push({ ...evt, name: 'wheeldown' })
        continue
      }
      patched?.push(evt)
      continue
    }
    // ② 键盘箭头误触丢弃：纯 up/down 在 75ms 键判窗内
    if (
      (evt.name === 'up' || evt.name === 'down') &&
      !evt.ctrl &&
      !evt.meta &&
      !evt.shift &&
      now - state.lastWheelTime < KEY_WINDOW_MS
    ) {
      if (!state.notified) {
        state.notified = true
        notify()
      }
      confirmBug(state)
      patched ??= inputs.slice(0, p)
      continue
    }
    patched?.push(evt)
  }
  return patched ?? inputs
}
