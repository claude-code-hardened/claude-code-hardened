/**
 * argv0 分发器（对齐 ant-native 的双身份二进制形态）。
 *
 * compile 产物被 `exec -a rg|bfs|ugrep ccb`（bash）或 `ARGV0=... execPath`
 * （zsh/Windows）调用时，cli.tsx main() 在 Commander 解析前调用本模块：
 * stage 对应的内嵌二进制 → spawnSync 透传 stdio/参数 → 以子进程退出码退出。
 *
 * stage 失败（非 Linux 且 tmpfs 不可用等极端场景）→ 落回 PATH 里的同名
 * 工具，保证 shell 集成永不静默坏掉。
 */

import { logForDebugging } from './debug.js'
import { getEmbeddedRg } from './embeddedRg.js'
import { getEmbeddedSearchTool } from './embeddedSearchTools.js'
import { probeSpawnable } from './embeddedStage.js'

/**
 * 执行嵌入工具并返回进程退出码。永不 throw——所有失败都转为
 * PATH 回退（或 127）。
 */
export async function dispatchEmbeddedTool(
  name: 'rg' | 'bfs' | 'ugrep',
  args: string[],
): Promise<number> {
  const { spawnSync } = await import('node:child_process')
  const staged = name === 'rg' ? getEmbeddedRg() : getEmbeddedSearchTool(name)

  if (staged && probeSpawnable(staged.command)) {
    logForDebugging(
      `[dispatch] ${name}: embedded binary staged at ${staged.command}`,
    )
    const r = spawnSync(staged.command, args, { stdio: 'inherit' })
    return r.status ?? 1
  }

  // stage 失败 → PATH 回退（宿主机装了 rg/bfs/ugrep 就继续可用）
  logForDebugging(
    `[dispatch] ${name}: embedded staging unavailable → PATH fallback`,
  )
  const fallback = spawnSync(name, args, { stdio: 'inherit' })
  return fallback.status ?? 127
}
