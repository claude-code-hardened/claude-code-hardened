import { describe, expect, test } from 'bun:test'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zhCN from './locales/zh-CN.json'
import zhTW from './locales/zh-TW.json'
import { AVAILABLE_LOCALES, normalizeTag, type Locale } from './normalize.js'
import { LOCALE_SPINNER_VERBS } from './spinnerVerbs.js'

describe('i18n locale normalization', () => {
  test('maps exact tags', () => {
    expect(normalizeTag('zh-CN')).toBe('zh-CN')
    expect(normalizeTag('ja')).toBe('ja')
    expect(normalizeTag('ko')).toBe('ko')
    expect(normalizeTag('en')).toBe('en')
  })

  test('maps LANG-style values with encoding suffixes', () => {
    expect(normalizeTag('zh_CN.UTF-8')).toBe('zh-CN')
    expect(normalizeTag('zh_TW.utf8')).toBe('zh-TW')
    expect(normalizeTag('ja_JP.UTF-8')).toBe('ja')
    expect(normalizeTag('ko_KR')).toBe('ko')
    expect(normalizeTag('en_US.UTF-8')).toBe('en')
  })

  test('maps bare zh to simplified and hant variants to zh-TW', () => {
    expect(normalizeTag('zh')).toBe('zh-CN')
    expect(normalizeTag('zh-Hant')).toBe('zh-TW')
    expect(normalizeTag('zh-HK')).toBe('zh-TW')
  })

  test('unknown languages fall back to en', () => {
    expect(normalizeTag('fr_FR')).toBe('en')
    expect(normalizeTag('')).toBe('en')
  })
})

describe('i18n locale packs', () => {
  const PACKS: Record<string, Record<string, string>> = {
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    ja,
    ko,
  }

  test('all locale packs cover the same key set', () => {
    // zh-CN is the reference set — every other locale must match exactly,
    // otherwise a locale silently misses translations.
    const refKeys = Object.keys(zhCN).sort()
    for (const [locale, pack] of Object.entries(PACKS)) {
      if (locale === 'zh-CN') continue
      expect(Object.keys(pack).sort()).toEqual(refKeys)
    }
  })

  test('no translation is a stub equal to the English key', () => {
    for (const [locale, pack] of Object.entries(PACKS)) {
      for (const [key, value] of Object.entries(pack)) {
        if (value === key) {
          throw new Error(`${locale} has stub translation for: ${key}`)
        }
      }
    }
  })

  test('every locale has a spinner verb list', () => {
    for (const locale of AVAILABLE_LOCALES) {
      if (locale === 'en') continue
      const verbs = LOCALE_SPINNER_VERBS[locale as Locale]
      expect(verbs).toBeDefined()
      expect(verbs!.length).toBeGreaterThanOrEqual(20)
      expect(verbs!.every(v => v.length > 0)).toBe(true)
    }
  })
})
