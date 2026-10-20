/**
 * Test-side locale pin.
 *
 * Importing this module sets CLAUDE_LANGUAGE=en so `t()` returns the English
 * key pass-through deterministically, regardless of the developer machine's
 * LANG (e.g. zh_CN locales would otherwise return pack translations for any
 * key that has been added to src/i18n/locales/*.json).
 *
 * Import-order requirement: list this import FIRST in the test file — ES
 * modules evaluate depth-first in listed order, so the pin is in place before
 * any module-under-test with module-scope t() calls (e.g. focus.ts's
 * FOCUS_RENDERER_NOTE) is evaluated.
 */
process.env.CLAUDE_LANGUAGE = 'en'
