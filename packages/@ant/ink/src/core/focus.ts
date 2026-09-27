import type { DOMElement } from './dom.js'
import { FocusEvent } from './events/focus-event.js'

const MAX_FOCUS_STACK = 32

/**
 * DOM-like focus manager for the Ink terminal UI.
 *
 * Pure state — tracks activeElement and a focus stack. Has no reference
 * to the tree; callers pass the root when tree walks are needed.
 *
 * Stored on the root DOMElement so any node can reach it by walking
 * parentNode (like browser's `node.ownerDocument`).
 */
export class FocusManager {
  activeElement: DOMElement | null = null
  private dispatchFocusEvent: (target: DOMElement, event: FocusEvent) => boolean
  private enabled = true
  private focusStack: DOMElement[] = []
  /** 官方 autoFocusStack：autoFocus 回退栈（resolveScope 三级回退 + 移除兜底）。 */
  private autoFocusStack: DOMElement[] = []
  /** 官方 listeners：store 订阅（React 侧 useSyncExternalStore 依赖）。 */
  private listeners = new Set<VoidFn>()

  constructor(
    dispatchFocusEvent: (target: DOMElement, event: FocusEvent) => boolean,
  ) {
    this.dispatchFocusEvent = dispatchFocusEvent
  }

  /** 官方 subscribe：store 订阅。 */
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 官方 notify：listeners 遍历（focus/blur/移除每步调用）。 */
  private notify(): void {
    for (const cb of this.listeners) cb()
  }

  /** 官方 resolveScope：tabIndex!==-1 直取；否则三级回退。 */
  private resolveScope(node: DOMElement): DOMElement {
    if (node.attributes['tabIndex'] !== -1) return node
    const usable = (n: DOMElement | null): boolean =>
      !!n && n !== node && isTabbable(n) && isInTree(n, node)
    if (usable(this.activeElement as DOMElement))
      return this.activeElement as DOMElement
    const recent = this.focusStack.findLast(usable)
    if (recent) return recent
    return (
      this.autoFocusStack.findLast(
        n => n.attributes['autoFocus'] === true && usable(n),
      ) ?? node
    )
  }

  /** 官方 pushAutoFocusFallback：去重 + 上限。 */
  private pushAutoFocusFallback(node: DOMElement): void {
    if (this.autoFocusStack.at(-1) === node) return
    const idx = this.autoFocusStack.indexOf(node)
    if (idx !== -1) this.autoFocusStack.splice(idx, 1)
    this.autoFocusStack.push(node)
    if (this.autoFocusStack.length > MAX_FOCUS_STACK)
      this.autoFocusStack.shift()
  }

  focus(rawNode: DOMElement): void {
    // 官方语义：先 resolveScope（tabIndex!==-1 直取 / 三级回退）
    const node = this.resolveScope(rawNode)
    if (node === this.activeElement) return
    if (!this.enabled) return

    const previous = this.activeElement
    if (previous) {
      // Deduplicate before pushing to prevent unbounded growth from Tab cycling
      const idx = this.focusStack.indexOf(previous)
      if (idx !== -1) this.focusStack.splice(idx, 1)
      this.focusStack.push(previous)
      if (this.focusStack.length > MAX_FOCUS_STACK) this.focusStack.shift()
      this.dispatchFocusEvent(previous, new FocusEvent('blur', node))
    }
    this.activeElement = node
    this.dispatchFocusEvent(node, new FocusEvent('focus', previous))
    this.notify()
  }

  blur(): void {
    if (!this.activeElement) return

    const previous = this.activeElement
    this.activeElement = null
    this.dispatchFocusEvent(previous, new FocusEvent('blur', null))
    this.notify()
  }

  /**
   * Called by the reconciler when a node is removed from the tree.
   * Handles both the exact node and any focused descendant within
   * the removed subtree. Dispatches blur and restores focus from stack.
   */
  handleNodeRemoved(node: DOMElement, root: DOMElement): void {
    // Remove the node and any descendants from the stack
    this.focusStack = this.focusStack.filter(
      n => n !== node && isInTree(n, root),
    )

    // Check if activeElement is the removed node OR a descendant
    if (!this.activeElement) return
    if (this.activeElement !== node && isInTree(this.activeElement, root)) {
      return
    }

    const removed = this.activeElement
    this.activeElement = null
    this.dispatchFocusEvent(removed, new FocusEvent('blur', null))

    // Restore focus to the most recent still-mounted element
    while (this.focusStack.length > 0) {
      const candidate = this.focusStack.pop()!
      if (isInTree(candidate, root)) {
        this.activeElement = candidate
        this.dispatchFocusEvent(candidate, new FocusEvent('focus', removed))
        this.notify()
        return
      }
    }
    // 官方兜底：autoFocusStack 末位恢复
    const autoFallback = this.autoFocusStack.at(-1)
    if (autoFallback) {
      this.activeElement = autoFallback
      this.dispatchFocusEvent(autoFallback, new FocusEvent('focus', removed))
    }
    this.notify()
  }

  handleAutoFocus(node: DOMElement): void {
    this.pushAutoFocusFallback(node)
    this.focus(node)
  }

  handleClickFocus(node: DOMElement): void {
    const tabIndex = node.attributes['tabIndex']
    if (typeof tabIndex !== 'number') return
    this.focus(node)
  }

  enable(): void {
    this.enabled = true
  }

  disable(): void {
    this.enabled = false
  }

  focusNext(root: DOMElement): void {
    this.moveFocus(1, root)
  }

  focusPrevious(root: DOMElement): void {
    this.moveFocus(-1, root)
  }

  private moveFocus(direction: 1 | -1, root: DOMElement): void {
    if (!this.enabled) return

    const tabbable = collectTabbable(root)
    if (tabbable.length === 0) return

    const currentIndex = this.activeElement
      ? tabbable.indexOf(this.activeElement)
      : -1

    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : tabbable.length - 1
        : (currentIndex + direction + tabbable.length) % tabbable.length

    const next = tabbable[nextIndex]
    if (next) {
      this.focus(next)
    }
  }
}

function collectTabbable(root: DOMElement): DOMElement[] {
  const result: DOMElement[] = []
  walkTree(root, result)
  return result
}

function walkTree(node: DOMElement, result: DOMElement[]): void {
  const tabIndex = node.attributes['tabIndex']
  if (typeof tabIndex === 'number' && tabIndex >= 0) {
    result.push(node)
  }

  for (const child of node.childNodes) {
    if (child.nodeName !== '#text') {
      walkTree(child, result)
    }
  }
}

/** 官方 dS：tabIndex>=0 可聚焦判定。 */
function isTabbable(node: DOMElement): boolean {
  const tabIndex = node.attributes['tabIndex']
  return typeof tabIndex === 'number' && tabIndex >= 0
}

function isInTree(node: DOMElement, root: DOMElement): boolean {
  let current: DOMElement | undefined = node
  while (current) {
    if (current === root) return true
    current = current.parentNode
  }
  return false
}

/**
 * Walk up to root and return it. The root is the node that holds
 * the FocusManager — like browser's `node.getRootNode()`.
 */
export function getRootNode(node: DOMElement): DOMElement {
  let current: DOMElement | undefined = node
  while (current) {
    if (current.focusManager) return current
    current = current.parentNode
  }
  throw new Error('Node is not in a tree with a FocusManager')
}

/**
 * Walk up to root and return its FocusManager.
 * Like browser's `node.ownerDocument` — focus belongs to the root.
 */
export function getFocusManager(node: DOMElement): FocusManager {
  return getRootNode(node).focusManager!
}
