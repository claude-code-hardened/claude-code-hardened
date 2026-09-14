import { readFileSync } from 'node:fs'

describe('file-index native (rg listing + Rust index search)', () => {
  const libSource = readFileSync(
    'packages/file-index-napi/native/src/lib.rs',
    'utf8',
  )
  const indexSource = readFileSync(
    'packages/file-index-napi/src/index.ts',
    'utf8',
  )
  const hookSource = readFileSync('src/hooks/fileSuggestions.ts', 'utf8')

  test('lib.rs exposes the napi index surface with no pure-FFI scan remnants', () => {
    // napi 通道（2026-09-15 实测生效）：isNativeFileIndex + NativeFileIndex
    // 静态工厂 + 类方法驼峰面，entry 方法 catch_unwind 隔离 panic。
    expect(libSource).toContain('pub struct NativeFileIndex')
    expect(libSource).toContain('pub fn is_native_file_index')
    expect(libSource).toContain('load_from_file_list')
    expect(libSource).toContain('append_paths')
    expect(libSource).toContain('catch_unwind')
    // 纯 FFI 扫描通道已整体移除（裁定：rg 采列表 + Rust 索引搜索）。
    expect(libSource).not.toContain('ccb_scan_files_into')
    expect(libSource).not.toContain('jwalk')
    expect(libSource).not.toContain('WalkDir')
    // 旧 napi AsyncTask 通道同样不允许回归。
    expect(libSource).not.toContain('AsyncTask')
    expect(libSource).not.toContain('impl Task for')
  })

  test('js wrapper validates the real napi surface via the static factory', () => {
    // validate 必须对齐 Rust 实际导出面（此前检查不存在的顶层自由函数
    // 导致 embedded 加载永远 invalid module）；
    // #[napi(factory)] 生成静态方法而非构造器（new NativeFileIndex() 抛错）。
    expect(indexSource).toContain('mod.NativeFileIndex.createNativeFileIndex()')
    expect(indexSource).toContain("typeof m.isNativeFileIndex === 'function'")
    expect(indexSource).toContain("typeof m.NativeFileIndex === 'function'")
  })

  test('non-git fallback goes straight to ripgrep (no ffi scan)', () => {
    // rg 采列表（node_modules/.bun glob 排除防分钟级扫描），灌进 Rust 索引。
    expect(hookSource).not.toContain('scanProjectFilesFfi')
    expect(hookSource).not.toContain('ffiFileScanner')
    expect(hookSource).not.toContain('FFI_SCAN_EXCLUDES')
    const rgPos = hookSource.indexOf('await ripGrep(')
    expect(rgPos).toBeGreaterThan(-1)
    expect(hookSource).toContain("'!node_modules/'")
    expect(hookSource).toContain("'!.bun/'")
    // FEATURE_FILE_INDEX_NATIVE=0 必须恢复纯 TS/rg 路径（kill switch，
    // 门住 native 索引构造）。
    expect(hookSource).toContain("feature('FILE_INDEX_NATIVE')")
  })
})
