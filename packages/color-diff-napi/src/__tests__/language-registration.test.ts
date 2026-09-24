import { describe, expect, test } from 'bun:test'
import hljs from 'highlight.js/lib/core'
import { __test } from '../index.js'

// 语言按需异步注册，断言前必须等 core + 26 常用语言加载完成
await __test.hljsReady()

describe('highlight.js language registration', () => {
  const expectedLanguages = [
    'bash',
    'c',
    'cmake',
    'cpp',
    'csharp',
    'css',
    'diff',
    'dockerfile',
    'go',
    'graphql',
    'java',
    'javascript',
    'json',
    'kotlin',
    'makefile',
    'markdown',
    'perl',
    'php',
    'python',
    'ruby',
    'rust',
    'shell',
    'sql',
    'typescript',
    'xml',
    'yaml',
  ]

  test('all expected languages are registered', () => {
    for (const lang of expectedLanguages) {
      expect(hljs.getLanguage(lang)).toBeDefined()
    }
  })

  test('unregistered language returns undefined', () => {
    expect(hljs.getLanguage('totally-not-a-real-language-xyz')).toBeUndefined()
  })

  test('highlight works for TypeScript', () => {
    const result = hljs.highlight('const x: number = 42', {
      language: 'typescript',
      ignoreIllegals: true,
    })
    expect(result.value).toContain('const')
    expect(result.language).toBe('typescript')
  })

  test('highlight works for Python', () => {
    const result = hljs.highlight('def hello():\n    print("hi")', {
      language: 'python',
      ignoreIllegals: true,
    })
    expect(result.value).toContain('def')
    expect(result.language).toBe('python')
  })

  test('highlight works for JSON', () => {
    const result = hljs.highlight('{"key": "value"}', {
      language: 'json',
      ignoreIllegals: true,
    })
    expect(result.language).toBe('json')
  })

  test('highlight works for Bash', () => {
    const result = hljs.highlight('echo "hello world"', {
      language: 'bash',
      ignoreIllegals: true,
    })
    expect(result.language).toBe('bash')
  })

  test('all expected languages are registered (standalone)', () => {
    // When running standalone, only 26 languages are registered via index.ts.
    // When running in the full test suite, cliHighlight.ts imports the full
    // highlight.js bundle (190+ languages) which shares the same core singleton,
    // so the total count is higher. We verify our 26 languages are present regardless.
    const registered = hljs.listLanguages()
    for (const lang of expectedLanguages) {
      expect(registered).toContain(lang)
    }
    expect(registered.length).toBeGreaterThanOrEqual(expectedLanguages.length)
  })

  test('extra languages register asynchronously on demand', async () => {
    // 先摘掉 vim：断言的是本次按需注册，而不是别处全量 import 的残留
    hljs.unregisterLanguage('vim')
    expect(hljs.getLanguage('vim')).toBeUndefined()
    const pending = __test.ensureExtraLanguage('vim')
    // 同步路径不注册——本次渲染仍降级纯文本，下次才高亮
    expect(hljs.getLanguage('vim')).toBeUndefined()
    // EXTRA_LANGUAGES 之外的名字直接返回，不会触发加载
    expect(__test.ensureExtraLanguage('totally-not-real-xyz')).toBeUndefined()
    await pending
    expect(hljs.getLanguage('vim')).toBeDefined()
    expect(hljs.getLanguage('totally-not-real-xyz')).toBeUndefined()
  })
})
