import { readFileSync } from 'node:fs'

describe('file-index native scan via pure FFI', () => {
  const libSource = readFileSync(
    'packages/file-index-napi/native/src/lib.rs',
    'utf8',
  )
  const ffiSource = readFileSync('src/utils/ffiFileScanner.ts', 'utf8')
  const hookSource = readFileSync('src/hooks/fileSuggestions.ts', 'utf8')

  test('lib.rs exports ccb_scan_files_into as a panic-isolated extern "C" symbol', () => {
    // 纯 FFI 导出符号名必须存在（bun:ffi dlopen 按名绑定，无 napi 注册表）。
    expect(libSource).toContain('#[no_mangle]')
    expect(libSource).toContain('pub extern "C" fn ccb_scan_files_into')
    // panic 跨 extern "C" 边界会 abort 进程，必须 catch_unwind 隔离。
    expect(libSource).toContain('catch_unwind')
    // 与 rg --files --hidden 对齐：包含隐藏文件（jwalk 默认跳过隐藏条目，
    // 必须显式关闭）。不跟随符号链接——jwalk 0.8 无环检测，/root 实测
    // follow 遇符号链接环爆炸（137MB/404s），符号链接路径不进建议列表。
    expect(libSource).toContain('.follow_links(false)')
    expect(libSource).toContain('.skip_hidden(false)')
    // 旧 napi AsyncTask 通道已移除——导出通道只剩 extern "C"。
    expect(libSource).not.toContain('AsyncTask')
    expect(libSource).not.toContain('impl Task for')
  })

  test('ffi scanner binds the async bun:ffi symbol with the retry-once protocol', () => {
    // 'cstring' 入参让 bun:ffi 自动转换 JS 字符串（'ptr' 不能直接收字符串）；
    // async: true 让调用进 Bun 线程池返回 Promise，不阻塞事件循环。
    expect(ffiSource).toContain('ccb_scan_files_into')
    expect(ffiSource).toContain("'cstring'")
    expect(ffiSource).toContain("'usize'")
    expect(ffiSource).toContain("'isize'")
    expect(ffiSource).toContain('async: true')
    // 编译二进制：memfd → /dev/fd 是 Bun 1.4.2 下唯一可用的内嵌加载路径。
    expect(ffiSource).toContain('memfd_create')
    expect(ffiSource).toContain('/dev/fd/')
    // buf_len 不足 → -(所需字节数) → 扩容重试一次。
    expect(ffiSource).toContain('Buffer.allocUnsafe(-n)')
  })

  test('non-git fallback prefers the ffi scan before ripgrep', () => {
    // rg 子进程路径（56-64s @ 14.4 万文件 proot）降级路径必须原样保留，
    // ffi 扫描只能插在它之前（超时预算由 Rust 线程内自检：Bun 等待线程池
    // FFI Promise 期间 setTimeout 不触发，JS race 是运行时死路）。
    const ffiPos = hookSource.indexOf('scanProjectFilesFfi(')
    const rgPos = hookSource.indexOf('await ripGrep(')
    expect(ffiPos).toBeGreaterThan(-1)
    expect(rgPos).toBeGreaterThan(ffiPos)
    // 超时预算必须存在：deadline 以参数传给 Rust（防御性降级）。
    expect(hookSource).toContain('10_000')
    // 超时自检必须在扫描线程内（Instant::elapsed），JS 侧只 await。
    expect(libSource).toContain('scan_start.elapsed()')
    expect(hookSource).not.toContain('Promise.race')
    // 排除目录名与 rg 的 --glob 白名单语义对齐（含 .claude 转录目录）。
    expect(hookSource).toContain("'node_modules'")
    expect(hookSource).toContain("'.claude'")
    // FEATURE_FILE_INDEX_NATIVE=0 必须恢复纯 TS/rg 路径（kill switch）。
    expect(hookSource).toContain("feature('FILE_INDEX_NATIVE')")
  })
})
