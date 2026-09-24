// highlight.js's type defs carry `/// <reference lib="dom" />`. SSETransport,
// mcp/client, ssh, dumpPrompts use DOM types (TextDecodeOptions, RequestInfo)
// that only typecheck because the hljs import below pulls lib.dom in.
// tsconfig has lib: ["ESNext"] only — this ref preserves the status quo.
/// <reference lib="dom" />

import { extname } from 'path'
// 语言名查询不加载全量 hljs（192 语言实测 +22MB），而是复用
// color-diff-napi 的 loadHljs()：它按需加载 core 并注册 26 种常用语言，
// getLanguage 由此能查到别名。cli-highlight 自带的 hljs 10 是独立实例，
// 填不进这里的注册表，故不依赖它做查询。
import type hljs from 'highlight.js'

export type CliHighlight = {
  highlight: typeof import('cli-highlight').highlight
  supportsLanguage: typeof import('cli-highlight').supportsLanguage
}

// One promise shared by Fallback.tsx, markdown.ts, events.ts, getLanguageName.
let cliHighlightPromise: Promise<CliHighlight | null> | undefined

let loadedGetLanguage:
  | ((name: string) => { name?: string } | undefined)
  | undefined
async function loadCliHighlight(): Promise<CliHighlight | null> {
  try {
    const cliHighlight = await import('cli-highlight')
    const { loadHljs } = (await import('color-diff-napi')) as {
      loadHljs: () => Promise<typeof hljs>
    }
    const hljsApi = await loadHljs()
    loadedGetLanguage = hljsApi.getLanguage?.bind(hljsApi)
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
