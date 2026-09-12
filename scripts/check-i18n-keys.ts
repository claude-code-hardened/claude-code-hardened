/**
 * i18n key 同步校验：
 *   1. 源码中静态 t('...') 调用点 vs 语言包 key —— 漏迁 = error（CI 挂）
 *   2. 语言包里有但源码无静态调用的 key —— 死键 = warning
 *      （渲染层动态调用 t(cmd.description) 合法，故只警告不挂 CI）
 *   3. 跨包 key 集合不一致 —— error（与 index.test.ts 双保险）
 *   4. stub 翻译（value === key）—— error
 *
 * usage: bun run scripts/check-i18n-keys.ts [--fix-report-only]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const SRC_DIRS = ['src', 'packages']
const LOCALES_DIR = join(ROOT, 'src', 'i18n', 'locales')
const LOCALE_TAGS = ['zh-CN', 'zh-TW', 'ja', 'ko'] as const

// ── 收集源码文件 ──
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist') {
      continue
    }
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const files: string[] = []
for (const d of SRC_DIRS) {
  try {
    walk(join(ROOT, d), files)
  } catch {
    // dir missing
  }
}

// ── 提取静态 t('...') / t("...") 调用的 key ──
const calledKeys = new Map<string, { file: string; line: number }>()
const dynamicCallSites: string[] = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file).split(sep).join('/')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    // 跳过 import 与注释行
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue
    if (/^\s*import\b/.test(line)) continue
    // 静态调用：t('...') 或 t("...")
    const staticRe = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*[,)]/g
    let m: RegExpExecArray | null
    let hasStatic = false
    let hasCall = false
    while ((m = staticRe.exec(line))) {
      hasStatic = true
      hasCall = true
      const key = m[2]?.replace(/\\'/g, "'").replace(/\\"/g, '"')
      if (key && !(key in calledKeys)) {
        calledKeys.set(key, { file: rel, line: i + 1 })
      }
    }
    // 动态调用（无字面量参数的 t( 调用）
    if (!hasCall && /\bt\(\s*[a-zA-Z_$][\w.[\]]*\s*[,)]/.test(line)) {
      dynamicCallSites.push(`${rel}:${i + 1}`)
    } else if (hasStatic === false && /\bt\(\s*`/.test(line)) {
      dynamicCallSites.push(`${rel}:${i + 1}`)
    }
  }
}

// ── 读取语言包 ──
const packs = new Map<string, Record<string, string>>()
for (const tag of LOCALE_TAGS) {
  const p = join(LOCALES_DIR, `${tag}.json`)
  packs.set(tag, JSON.parse(readFileSync(p, 'utf8')))
}

let errors = 0
let warnings = 0

// ── 1. 跨包一致性 ──
const base = packs.get('zh-CN') as Record<string, string>
const baseKeys = new Set(Object.keys(base))
for (const [tag, pack] of packs) {
  const keys = new Set(Object.keys(pack))
  for (const k of baseKeys) {
    if (!keys.has(k)) {
      console.error(`✗ [${tag}] 缺少 key: ${JSON.stringify(k)}`)
      errors++
    }
  }
  for (const k of keys) {
    if (!baseKeys.has(k)) {
      console.error(`✗ [${tag}] 多余 key: ${JSON.stringify(k)}`)
      errors++
    }
  }
}

// ── 2. stub 翻译 ──
for (const [tag, pack] of packs) {
  for (const [k, v] of Object.entries(pack)) {
    if (k === v && tag !== 'en') {
      console.error(
        `✗ [${tag}] stub 翻译 (value === key): ${JSON.stringify(k)}`,
      )
      errors++
    }
  }
}

// ── 3. 漏迁：调用点有、包里没有 ──
for (const [key, loc] of calledKeys) {
  if (!baseKeys.has(key)) {
    console.error(
      `✗ 漏迁 (调用点无翻译): ${JSON.stringify(key)} @ ${loc.file}:${loc.line}`,
    )
    errors++
  }
}

// ── 4. 死键：包里有、无静态调用点 ──
for (const key of baseKeys) {
  if (!calledKeys.has(key)) {
    console.warn(
      `⚠ 死键 (无静态调用点，可能为动态调用): ${JSON.stringify(key)}`,
    )
    warnings++
  }
}

console.log(
  `\n统计: 源码静态调用 key ${calledKeys.size} 条 | 语言包 key ${baseKeys.size} 条 | 动态调用点 ${dynamicCallSites.length} 处`,
)
console.log(`结果: ${errors} errors, ${warnings} warnings`)
if (errors > 0) process.exit(1)
