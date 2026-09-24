/**
 * Embedded ripgrep for bun --compile binaries（薄封装，与 bfs/ugrep 统一
 * 走 embeddedStage.ts 的通用 staging：memfd → /dev/shm → tmpdir 三级策略
 * + noexec 探测，见该文件头部的实测坑记录）。
 */

import { EMBEDDED_RIPGREP } from './embeddedRg.gen'
import { stageExecutable } from './embeddedStage.js'
import type { StagedExecutable } from './embeddedStage.js'

export type EmbeddedRg = StagedExecutable

/** 编译产物里是否带了 rg（dev / 常规构建为 false）。 */
export function hasEmbeddedRg(): boolean {
  return typeof EMBEDDED_RIPGREP === 'string' && EMBEDDED_RIPGREP.length > 0
}

/**
 * 返回可直接 spawn 的 rg 命令；未嵌入或全部策略失败返回 null，调用方
 * 走 vendor/系统 rg 回退。结果模块级缓存（embeddedStage 内）。
 */
export function getEmbeddedRg(): EmbeddedRg | null {
  if (!hasEmbeddedRg()) return null
  return stageExecutable(
    'rg',
    EMBEDDED_RIPGREP!,
    process.platform === 'win32' ? 'rg.exe' : 'rg',
  )
}
