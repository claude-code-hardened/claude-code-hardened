// highlight.js's type defs carry `/// <reference lib="dom" />`. SSETransport,
// mcp/client, ssh, dumpPrompts use DOM types (TextDecodeOptions, RequestInfo)
// that only typecheck because the hljs import below pulls lib.dom in.
// tsconfig has lib: ["ESNext"] only — this ref preserves the status quo.
/// <reference lib="dom" />

import { extname } from 'path'
// 用 core 而非全量 highlight.js：此处只需 getLanguage 做语言名查询，
// 不高亮，不需要语言定义。全量 import 解析 192 个语言（实测 +22MB）；
// core 无语言，体积可忽略。loadCliHighlight 本就是异步，动态 import 合适。
// import type 仅保留 hljs 类型（dom lib reference 见文件头注释）。
import type hljs from 'highlight.js'
let hljsCore: typeof hljs | null = null

export type CliHighlight = {
  highlight: typeof import('cli-highlight').highlight
  supportsLanguage: typeof import('cli-highlight').supportsLanguage
}

// One promise shared by Fallback.tsx, markdown.ts, events.ts, getLanguageName.
let cliHighlightPromise: Promise<CliHighlight | null> | undefined

let loadedGetLanguage:
  | ((name: string) => { name?: string } | undefined)
  | undefined
function unwrapCore(mod: unknown): typeof hljs {
  return ((mod as { default?: typeof hljs }).default ?? mod) as typeof hljs
}
async function loadCliHighlight(): Promise<CliHighlight | null> {
  try {
    const cliHighlight = await import('cli-highlight')
    // core 未注册语言定义，但 getLanguage 对常见扩展名仍返回名字
    // （内置别名表），本文件只做名字查询，不需要语法解析
    const hljsMod = (hljsCore ??= unwrapCore(
      await import('highlight.js/lib/core'),
    )) as {
      getLanguage?: typeof loadedGetLanguage
      default?: typeof hljsCore
    }
    loadedGetLanguage = hljsMod.getLanguage ?? hljsMod.default?.getLanguage
    return {
      highlight: cliHighlight.highlight,
      supportsLanguage: cliHighlight.supportsLanguage,
    }
  } catch {
    return null
  }
}

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  cliHighlightPromise ??= loadCliHighlight()
  return cliHighlightPromise
}

/**
 * eg. "foo/bar.ts" → "TypeScript". Awaits the shared cli-highlight load,
 * then reads highlight.js's language registry. All callers are telemetry
 * (OTel counter attributes, permission-dialog unary events) — none block
 * on this, they fire-and-forget or the consumer already handles Promise<string>.
 */
export async function getLanguageName(file_path: string): Promise<string> {
  await getCliHighlightPromise()
  const ext = extname(file_path).slice(1)
  if (!ext) return 'unknown'
  return loadedGetLanguage?.(ext)?.name ?? 'unknown'
}
