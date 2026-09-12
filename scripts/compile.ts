/**
 * 单文件可执行二进制编译（bun build --compile）。
 *
 * 与 build.ts（splitting bundle）不同：compile 必须单 bundle 内嵌，
 * 不做 code splitting（chunk 是运行时外部文件，装不进二进制）。
 * 产物：dist/ccb-<os>-<arch>[.exe] —— 无需安装 Node/Bun，下载即运行。
 *
 * Native 模块嵌入策略：
 *   - 读取目标平台对应的 .node 文件
 *   - 转为 base64 注入到 bundle（通过 Bun plugin 提供 virtual module "embedded:natives"）
 *   - 运行时通过 src/utils/embeddedNative.ts 提取到临时目录加载
 *
 * usage: bun run scripts/compile.ts [target ...]
 *   target 形如 bun-linux-x64 / bun-linux-arm64 / bun-darwin-arm64 / bun-windows-x64
 *   不传则编译全部平台。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './defines.ts'

const ALL_TARGETS = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
]

const requested = process.argv.slice(2)
const targets = requested.length > 0 ? requested : ALL_TARGETS

const envFeatures = Object.keys(process.env)
  .filter(k => k.startsWith('FEATURE_'))
  .map(k => k.replace('FEATURE_', ''))
const features = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]

// Crate 映射：package 名 -> { crate 名（cdylib 产物名）, vendor 子目录名 }
const CRATES = [
  {
    pkg: 'token-counter-napi',
    crate: 'token_counter_napi',
    vendorDir: 'token-counter',
    moduleName: 'token-counter',
  },
  {
    pkg: 'transcript-parser-napi',
    crate: 'transcript_parser_napi',
    vendorDir: 'transcript-parser',
    moduleName: 'transcript-parser',
  },
  {
    pkg: 'color-diff-napi',
    crate: 'color_diff_napi',
    vendorDir: 'color-diff',
    moduleName: 'color-diff',
  },
]

function artifactName(crate: string, platform: string): string {
  if (platform.endsWith('-windows-msvc')) return `${crate}.dll`
  if (platform.endsWith('-apple-darwin')) return `lib${crate}.dylib`
  return `lib${crate}.so`
}

function targetToTriple(target: string): string {
  const map: Record<string, string> = {
    'bun-linux-x64': 'x86_64-unknown-linux-gnu',
    'bun-linux-arm64': 'aarch64-unknown-linux-gnu',
    'bun-darwin-x64': 'x86_64-apple-darwin',
    'bun-darwin-arm64': 'aarch64-apple-darwin',
    'bun-windows-x64': 'x86_64-pc-windows-msvc',
  }
  return map[target] ?? 'unknown'
}

function readNativeAsBase64(
  vendorDir: string,
  triple: string,
  moduleName: string,
): string | null {
  const candidate = join('vendor', vendorDir, triple, `${moduleName}.node`)
  if (!existsSync(candidate)) {
    console.warn(`  [embed] Native not found: ${candidate}`)
    return null
  }
  const buffer = readFileSync(candidate)
  return buffer.toString('base64')
}

// Create a Bun plugin that overrides src/utils/embeddedNatives.gen.ts
// with the target platform's real base64 native modules.
function createEmbeddedNativesPlugin(embeddedNatives: Record<string, string>) {
  return {
    name: 'embedded-natives',
    setup(build: any) {
      build.onResolve({ filter: /embeddedNatives\.gen(\.ts)?$/ }, args => ({
        path: args.path,
        namespace: 'embedded-natives',
      }))
      build.onLoad({ filter: /.*/, namespace: 'embedded-natives' }, () => ({
        contents: `export const EMBEDDED_NATIVES = ${JSON.stringify(embeddedNatives)};\n`,
        loader: 'js',
      }))
    },
  }
}

for (const target of targets) {
  const triple = targetToTriple(target)

  // ── 收集当前 target 的所有 native 模块 base64 ──
  const embeddedNatives: Record<string, string> = {}
  for (const { vendorDir, moduleName, crate } of CRATES) {
    const base64 = readNativeAsBase64(vendorDir, triple, moduleName)
    if (base64) {
      embeddedNatives[moduleName] = base64
      console.log(
        `  [embed] ${moduleName} (${triple}): ${Math.round((base64.length * 0.75) / 1024)} KB`,
      )
    }
  }

  // ── Bun.build --compile with embedded natives plugin ──
  const result = await Bun.build({
    entrypoints: ['src/entrypoints/cli.tsx'],
    target: 'bun',
    define: {
      ...getMacroDefines(),
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    features,
    plugins: [createEmbeddedNativesPlugin(embeddedNatives)],
    compile: {
      // 单数 target 是唯一生效的 API：复数 targets 会被静默忽略，
      // 产物退化为 host 架构（CI x86 上曾把 arm64 名字编成 x86_64 ELF）。
      target,
      outfile: `dist/ccb-${target.replace(/^bun-/, '')}`,
    },
  })

  if (!result.success) {
    console.error(`compile failed for ${target}:`)
    for (const log of result.logs) {
      console.error(log)
    }
    process.exit(1)
  }
  console.log(
    `compiled: dist/ccb-${target.replace(/^bun-/, '')}${target.endsWith('windows-x64') ? '.exe' : ''}`,
  )
}
