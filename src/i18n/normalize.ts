/**
 * Locale tag normalization — pure logic, no dependencies.
 * Kept separate from index.ts so tests and lightweight callers avoid
 * importing the settings/auth dependency chain.
 */
export const AVAILABLE_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'] as const
export type Locale = (typeof AVAILABLE_LOCALES)[number]

/**
 * Map a raw language tag (LANG value, BCP-47, etc.) to a supported locale.
 * Unknown languages fall back to 'en'.
 */
export function normalizeTag(tag: string): Locale {
  const lower = tag.trim().toLowerCase()
  const exact = AVAILABLE_LOCALES.find(l => l.toLowerCase() === lower)
  if (exact) return exact
  // Language subtag match: e.g. LANG=zh_CN.UTF-8 → zh-CN, ja_JP → ja
  const sub = lower.split(/[-_.]/)[0]
  if (sub === 'zh') {
    // Prefer matching script/region: zh-tw/zh-hk/zh-hant → zh-TW
    return /tw|hk|mo|hant/.test(lower) ? 'zh-TW' : 'zh-CN'
  }
  const bySub = AVAILABLE_LOCALES.find(
    l => l.toLowerCase().split('-')[0] === sub,
  )
  return bySub ?? 'en'
}
