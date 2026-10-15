import { homedir } from 'os'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import {
  expandTilde,
  globToRegex,
  pathMatchesRule,
  splitRootFromPattern,
} from '../matchers.js'

describe('expandTilde', () => {
  test('expands bare ~ to the home directory', () => {
    expect(expandTilde('~')).toBe(homedir())
  })

  test('expands ~/ prefixed paths', () => {
    expect(expandTilde('~/docs/notes')).toBe(join(homedir(), 'docs/notes'))
  })

  test('leaves relative paths untouched', () => {
    expect(expandTilde('src/lib')).toBe('src/lib')
  })

  test('leaves absolute paths untouched (including mid-string ~)', () => {
    expect(expandTilde('/tmp/a~b')).toBe('/tmp/a~b')
  })
})

describe('splitRootFromPattern', () => {
  test('splits absolute glob patterns at the static prefix', () => {
    const { root, relativePattern } = splitRootFromPattern('/repo/src/**')
    expect(root).toBe('/repo/src')
    expect(relativePattern).toBe('**')
  })

  test('anchors static absolute paths at their parent', () => {
    const { root, relativePattern } = splitRootFromPattern('/etc')
    expect(root).toBe('/')
    expect(relativePattern).toBe('etc')
  })

  test('returns relative patterns with an empty root', () => {
    const { root, relativePattern } = splitRootFromPattern('docs/**')
    expect(root).toBe('')
    expect(relativePattern).toBe('docs/**')
  })

  test('expands ~ roots in patterns', () => {
    const { root } = splitRootFromPattern('~/work/**')
    expect(root).toBe(join(homedir(), 'work'))
  })
})

describe('globToRegex', () => {
  test('** suffix matches nested paths', () => {
    expect(globToRegex('**').test('a/b/c')).toBe(true)
  })

  test('single * matches one path segment only', () => {
    const re = globToRegex('*')
    expect(re.test('file.ts')).toBe(true)
    expect(re.test('dir/file.ts')).toBe(false)
  })

  test('double ** matches across separators', () => {
    const re = globToRegex('src/**')
    expect(re.test('src')).toBe(true)
    expect(re.test('src/a')).toBe(true)
    expect(re.test('src/a/b/c.ts')).toBe(true)
    expect(re.test('other/src/a')).toBe(false)
  })

  test('leading **/ matches any prefix including none', () => {
    const re = globToRegex('**/node_modules/**')
    expect(re.test('node_modules/pkg')).toBe(true)
    expect(re.test('a/b/node_modules/pkg')).toBe(true)
    expect(re.test('other/pkg')).toBe(false)
  })

  test('regex escapes special chars', () => {
    const re = globToRegex('a(b).ts')
    expect(re.test('a(b).ts')).toBe(true)
    expect(re.test('aab')).toBe(false)
  })

  test('matching is case-insensitive', () => {
    expect(globToRegex('docs/*').test('DOCS/README')).toBe(true)
  })
})

describe('pathMatchesRule', () => {
  const base = '/base/project'

  test('matches relative patterns against the base directory', () => {
    expect(pathMatchesRule('docs/**', '/base/project/docs/a.md', base)).toBe(
      true,
    )
    // 单个 `*` 只匹配一段：不得跨目录层级命中嵌套路径。
    expect(
      pathMatchesRule('docs/*', '/base/project/docs/nested/a.md', base),
    ).toBe(false)
    expect(pathMatchesRule('docs/*', '/base/project/docs/a', base)).toBe(true)
    expect(pathMatchesRule('other/**', '/base/project/docs/a.md', base)).toBe(
      false,
    )
  })

  test('relativizes absolute patterns against their own root', () => {
    expect(pathMatchesRule('/base/**', '/base/any/where', base)).toBe(true)
    expect(
      pathMatchesRule('/base/project/src/**', '/base/project/src/a.ts', base),
    ).toBe(true)
  })

  test('refuses realpath escapes outside the rule root (越权边界)', () => {
    // Target realpath sits outside the rule root — even a wildcard rule
    // must not match it (official B(): relative() starting with '../').
    expect(pathMatchesRule('/base/project/docs/**', '/etc/passwd', base)).toBe(
      false,
    )
    expect(pathMatchesRule('/base/docs/**', '/base/other/x', base)).toBe(false)
  })

  test('refuses sibling-prefix escapes (docs vs docs-evil)', () => {
    expect(pathMatchesRule('docs/**', '/base/project/docs-evil/x', base)).toBe(
      false,
    )
  })

  test('matches the rule root itself for exact-directory patterns', () => {
    expect(
      pathMatchesRule('/base/project/exact', '/base/project/exact', base),
    ).toBe(true)
    expect(
      pathMatchesRule('/base/project/exact', '/base/project/exact/inner', base),
    ).toBe(false)
  })
})
