/**
 * i18n infrastructure.
 *
 * Natural-key scheme: the English UI string IS the key. Call sites wrap
 * user-visible strings with t('...'); when the active locale has a
 * translation it is returned, otherwise the English string passes through
 * unchanged. This keeps English working with zero per-string key naming
 * and makes migration incremental.
 *
 * Locale resolution order:
 *   1. settings.json "uiLocale"
 *   2. CLAUDE_LANGUAGE env var
 *   3. LANG env var (first subtag matched against available locales)
 *   4. 'en' (strings in code — always available)
 *
 * Translations live in ./locales/<tag>.json — flat string-to-string maps.
 */
import i18next, { type i18n as I18n } from 'i18next'
import { isEnvTruthy } from '../utils/envUtils.js'
import { getInitialSettings } from '../utils/settings/settings.js'

import ko from './locales/ko.json'
import zhCN from './locales/zh-CN.json'
import zhTW from './locales/zh-TW.json'
import ja from './locales/ja.json'
import { normalizeTag, type Locale, AVAILABLE_LOCALES } from './normalize.js'

export { normalizeTag, AVAILABLE_LOCALES }
export type { Locale }

const RESOURCES: Record<string, { translation: Record<string, string> }> = {
  'zh-CN': { translation: zhCN },
  'zh-TW': { translation: zhTW },
  ja: { translation: ja },
  ko: { translation: ko },
}

export function resolveLocale(): Locale {
  const setting = getInitialSettings().uiLocale
  if (setting) return normalizeTag(setting)

  const claudeLang = process.env.CLAUDE_LANGUAGE
  if (claudeLang) return normalizeTag(claudeLang)

  const lang = process.env.LANG
  if (lang && !isEnvTruthy('CLAUDE_LANGUAGE_ENFORCE_EN')) {
    return normalizeTag(lang)
  }
  return 'en'
}

let instance: I18n | null = null

function getI18n(): I18n {
  if (instance) return instance
  const lng = resolveLocale()
  // initImmediate is not set: resources are static, init is synchronous.
  instance = i18next.createInstance()
  instance.init({
    lng,
    fallbackLng: 'en',
    resources: RESOURCES,
    // Natural keys: key === English text. No escaping — Ink renders plain text.
    interpolation: { escapeValue: false },
    returnNull: false,
    parseMissingKeyHandler: key => key,
  })
  return instance
}

/**
 * Translate a user-visible UI string into the active locale.
 * The input is the English text; untranslated strings pass through as-is.
 *
 * Interpolation: i18next `{{name}}` placeholders are substituted from
 * `options` (e.g. t('Loaded {{n}} messages', { n: 5 })). Keys stored in the
 * locale packs keep the placeholder; en passes the template through and
 * interpolates locally so English needs no pack entry.
 */
export function t(key: string, options?: Record<string, unknown>): string {
  if (resolveLocale() === 'en') {
    if (!options) return key
    return key.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      name in options ? String(options[name]) : match,
    )
  }
  return getI18n().t(key, options)
}

/** Active locale tag ('en' when no locale pack is selected). */
export function currentLocale(): Locale {
  return resolveLocale()
}
