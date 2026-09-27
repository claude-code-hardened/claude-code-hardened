import { NoSelect } from './NoSelect.js'

/**
 * 官方 SA：Decorative 组件（binary @152709648 原文反混淆）。
 *
 * 原文契约：
 *   function SA(o){ let {children, fallback} = o; return _t() ? fallback ?? null : children }
 *   —— _t() = useIsScreenReaderEnabled 的函数语境版。
 *
 * 语义：装饰性内容容器——屏幕阅读器启用时不渲染 children（避免辅助
 * 技术噪音），渲染 fallback（默认 null）。
 */
export function Decorative({
  children,
  fallback,
}: {
  children: React.ReactNode
  fallback?: React.ReactNode
}): React.ReactNode {
  const screenReaderEnabled = process.env['CLAUDE_CODE_SCREEN_READER'] === '1'
  if (screenReaderEnabled) {
    return fallback ?? null
  }
  return <NoSelect>{children}</NoSelect>
}
