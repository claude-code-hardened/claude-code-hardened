/**
 * bfs/ugrep 嵌入态已拆除：shell find/grep shadow 属"给人用"的人性化
 * 通道，Glob/Grep 专用工具恒注册（native 分支在各自 call() 内）。
 *
 * hasEmbeddedSearchTools() 是大量 prompt/message 文案分支的开关
 * （prompts.ts、messages.ts、memdir.ts、BashTool/AgentTool prompt 等）。
 * 原判定 =「嵌入 payload 非空 && 非 SDK 入口」；payload 源
 * （embeddedSearch.gen.ts / embeddedSearchTools.ts）已删除，恒为空 →
 * 收敛为恒 false，即所有文案走 Glob/Grep 专用工具分支（与常规构建
 * 现行行为一致）。保留导出以避免牵动上述消费点。
 */
export function hasEmbeddedSearchTools(): boolean {
  return false
}
