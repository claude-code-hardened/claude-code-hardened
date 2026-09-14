import { readFileSync } from 'node:fs'

describe('file-index native parallel scan guard', () => {
  const libSource = readFileSync(
    'packages/file-index-napi/native/src/lib.rs',
    'utf8',
  )
  const wrapperSource = readFileSync(
    'packages/file-index-napi/src/index.ts',
    'utf8',
  )
  const hookSource = readFileSync('src/hooks/fileSuggestions.ts', 'utf8')

  test('native module exports scan_project_files as a libuv AsyncTask', () => {
    // 14 万文件的目录扫描同步跑会阻塞 JS 事件循环、UI 冻结——导出必须
    // 以 napi AsyncTask（Promise）形式在 libuv 线程池执行。
    expect(libSource).toContain('pub fn scan_project_files')
    expect(libSource).toContain('impl Task for ScanProjectFilesTask')
    expect(libSource).toContain('AsyncTask<ScanProjectFilesTask>')
    // 与 rg --files --follow --hidden 对齐：跟随符号链接 + 包含隐藏文件
    // （jwalk 默认跳过隐藏条目，必须显式关闭）。
    expect(libSource).toContain('.follow_links(true)')
    expect(libSource).toContain('.skip_hidden(false)')
  })

  test('non-git fallback prefers the native scan before ripgrep', () => {
    // rg 子进程路径（56-64s @ 14.4 万文件 proot）降级路径必须原样保留，
    // native 扫描只能插在它之前。
    expect(wrapperSource).toContain('scanProjectFilesNative')
    expect(hookSource).toContain('getProjectFilesNativeScan')
    const nativePos = hookSource.indexOf('await getProjectFilesNativeScan(')
    const rgPos = hookSource.indexOf('await ripGrep(')
    expect(nativePos).toBeGreaterThan(-1)
    expect(rgPos).toBeGreaterThan(nativePos)
  })
})
