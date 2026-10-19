import type { Command } from '../types/command.js'
import type {
  SkillDoctorEngine,
  SkillUsageRecord,
} from '../commands/skill-doctor/engine.js'
import { getGlobalConfig } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { estimateSkillFrontmatterTokens } from './loadSkillsDir.js'
import { buildSkillIdentifier } from './syncedSkills.js'

/**
 * cli_skill_doctor engine.
 *
 * Upstream anchor: docs/reverse-284/decompiled/0025-chunk-m7ywx1p7
 * module-003-uncategorized.js:
 *   :739  Xl — `R3t(report)` entry: `rows.length === 0` logs the
 *         `cli_skill_doctor` / `no_user_skills` event; `weekTokensNote`
 *         non-null flags a denied usage scan.
 *   :916  zl — dashboard categories: unusedOwned / unusedFromPlugins /
 *         unusedFromMcp / unusedSynced — "N skills loaded but never invoked.
 *         Each one adds to the system prompt every turn."
 *   :743  ql — row shape: name / source / context / 7d tokens / uses / last used.
 *
 * Usage counts come from the global-config skillUsage ledger
 * (`src/utils/suggestions/skillUsageTracking.ts`); no transcript scan is
 * performed. Cost ordering falls back to context-size estimation
 * (frontmatter tokens = what loaded-but-unused skills add to the system
 * prompt every turn).
 */

export type SkillUsage = { usageCount: number; lastUsedAt: number }

/** @returns usage ledger entry for a skill name, or undefined when unused. */
export type SkillUsageLookup = (name: string) => SkillUsage | undefined

export type SkillDoctorRow = {
  /** Skill invocation name (slash name). */
  name: string
  /** Stable `skill:` / `synced-skill:` prefixed identifier (anchor `Br`). */
  identifier: string
  /** Display source (userSettings / projectSettings / plugin / ...). */
  source: string
  /** Upstream loadFrom bucket owning this row. */
  loadedFrom: string
  /** Execution context declared by the skill (inline / fork). */
  context: 'inline' | 'fork' | undefined
  /** Estimated tokens this skill adds to the system prompt every turn. */
  contextTokens: number
  /** Rough tokens the skill consumed in the trailing 7-day window. */
  weekTokens: number
  usageCount: number
  lastUsedAt: number | null
}

export type SkillDoctorReport = {
  /** Every loaded skill (payload of the anchor's `rows`). */
  rows: SkillDoctorRow[]
  /** Loaded but never invoked — user/plugin-owned local surfaces. */
  unusedOwned: SkillDoctorRow[]
  /** Loaded but never invoked — contributed by plugins. */
  unusedFromPlugins: SkillDoctorRow[]
  /** Loaded but never invoked — surfaced via MCP. */
  unusedFromMcp: SkillDoctorRow[]
  /** Loaded but never invoked — claude.ai synced skills. */
  unusedSynced: SkillDoctorRow[]
  /** Non-null when the usage scan was unavailable (anchor `weekTokensNote`). */
  weekTokensNote: string | null
  /** rows.length === 0 — upstream logs `cli_skill_doctor` / `no_user_skills`. */
  noUserSkills: boolean
}

export type SkillDoctorOptions = {
  /**
   * Usage ledger override. Defaults to the global-config skillUsage map.
   * Tests inject this seam instead of mocking the config module.
   */
  usageLookup?: SkillUsageLookup
  /** Clock seam for the 7-day window (epoch ms). Defaults to Date.now(). */
  now?: number
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

// Command-side compatibility: /skill-doctor (W3) expects the
// `SkillDoctorEngine` / `SkillUsageRecord` names — re-exported here so a
// command-side swap from the stub engine needs no new import path.
export type {
  SkillDoctorEngine,
  SkillUsageRecord,
} from '../commands/skill-doctor/engine.js'

/** loadedFrom buckets, in doctor category order (anchor `zl` + local kinds). */
function doctorCategory(
  loadedFrom: string | undefined,
): keyof Pick<
  SkillDoctorReport,
  'unusedOwned' | 'unusedFromPlugins' | 'unusedFromMcp' | 'unusedSynced'
> {
  switch (loadedFrom) {
    case 'syncedSkills':
      return 'unusedSynced'
    case 'plugin':
      return 'unusedFromPlugins'
    case 'mcp':
      return 'unusedFromMcp'
    // skills / commands_DEPRECATED / bundled / managed / undefined are all
    // "owned" surface: they add prompt cost and are user-manageable.
    default:
      return 'unusedOwned'
  }
}

/**
 * Doctor rows are only built for prompt commands (skills). `source` comes from
 * the PromptCommand variant of the Command union — LocalCommand /
 * LocalJSXCommand carry no `source`, so the row builder takes the extracted
 * prompt type instead of a plain Command.
 */
type PromptSkill = Extract<Command, { type: 'prompt' }>

function resolveLoadedFrom(skill: PromptSkill): string {
  return skill.loadedFrom ?? 'skills'
}

function buildDoctorRow(
  skill: PromptSkill,
  usage: SkillUsage | undefined,
  now: number,
): SkillDoctorRow {
  const contextTokens = estimateSkillFrontmatterTokens(skill)
  const usedInWindow =
    usage !== undefined && now - usage.lastUsedAt <= SEVEN_DAYS_MS
  return {
    name: skill.name,
    identifier: buildSkillIdentifier(skill),
    source: String(skill.source),
    loadedFrom: resolveLoadedFrom(skill),
    context: skill.context,
    contextTokens,
    weekTokens: usedInWindow
      ? contextTokens * Math.max(1, usage.usageCount)
      : 0,
    usageCount: usage?.usageCount ?? 0,
    lastUsedAt: usage?.lastUsedAt ?? null,
  }
}

/**
 * Builds the cli_skill_doctor report over the given loaded skills.
 *
 * Pure with respect to its inputs — the default usage lookup reads the global
 * config ledger, but callers (and tests) can inject {@link SkillDoctorOptions.usageLookup}.
 * Never throws on individual skills; malformed entries are skipped.
 */
export function runSkillDoctor(
  skills: readonly Command[],
  options?: SkillDoctorOptions,
): SkillDoctorReport {
  const now = options?.now ?? Date.now()
  const usageLookup = options?.usageLookup ?? globalSkillUsageLookup

  // weekTokensNote wiring (R5: the anchor's scan-denied note was previously a
  // hardcoded-null dead branch). CCH performs no transcript scan — usage comes
  // from the global-config ledger. Data-source limitation: the only way that
  // scan is unavailable is a failed ledger read, so that is the condition this
  // note now reports; with an injected usageLookup the caller owns the note.
  let weekTokensNote: string | null = null
  if (options?.usageLookup === undefined) {
    try {
      getGlobalConfig()
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      weekTokensNote =
        'Skill usage ledger unavailable (skillUsage config read failed) — 7-day usage columns are omitted'
      logForDebugging(`[skill-doctor] usage ledger read failed: ${message}`)
    }
  }

  const rows: SkillDoctorRow[] = []
  const unusedOwned: SkillDoctorRow[] = []
  const unusedFromPlugins: SkillDoctorRow[] = []
  const unusedFromMcp: SkillDoctorRow[] = []
  const unusedSynced: SkillDoctorRow[] = []
  const byCategory = {
    unusedOwned,
    unusedFromPlugins,
    unusedFromMcp,
    unusedSynced,
  } as const

  for (const skill of skills) {
    if (skill.type !== 'prompt') continue
    let usage: SkillUsage | undefined
    try {
      usage = usageLookup(skill.name)
    } catch (e: unknown) {
      logForDebugging(
        `[skill-doctor] usage lookup failed for ${skill.name}: ${e}`,
      )
      usage = undefined
    }
    const row = buildDoctorRow(skill, usage, now)
    rows.push(row)
    if (row.usageCount === 0) {
      byCategory[doctorCategory(resolveLoadedFrom(skill))].push(row)
    }
  }

  sortRowsForDisplay(rows)
  // Anchor semantics: unused skills are the actionable output, so costlier
  // (context-size estimate) skills surface first.
  for (const bucket of [
    unusedOwned,
    unusedFromPlugins,
    unusedFromMcp,
    unusedSynced,
  ]) {
    bucket.sort(
      (a, b) =>
        b.contextTokens - a.contextTokens || a.name.localeCompare(b.name),
    )
  }

  return {
    rows,
    unusedOwned,
    unusedFromPlugins,
    unusedFromMcp,
    unusedSynced,
    // Non-null only when the usage ledger itself is unreadable (above); a
    // healthy read — or an injected lookup — keeps the anchor's note null.
    weekTokensNote,
    noUserSkills: rows.length === 0,
  }
}

/** Unused rows last, then by trailing-7d cost, then by name for stability. */
function sortRowsForDisplay(rows: SkillDoctorRow[]): void {
  rows.sort((a, b) => {
    if (a.usageCount === 0 && b.usageCount !== 0) return 1
    if (a.usageCount !== 0 && b.usageCount === 0) return -1
    if (b.weekTokens !== a.weekTokens) return b.weekTokens - a.weekTokens
    return a.name.localeCompare(b.name)
  })
}

/** Default usage lookup — the global-config skillUsage ledger. */
export const globalSkillUsageLookup: SkillUsageLookup = name =>
  getGlobalConfig().skillUsage?.[name]

/** Test seam: callers inject {@link SkillDoctorOptions.usageLookup} instead. */
export function resetSkillDoctorUsageCache(): void {
  // No module-level cache is kept: getGlobalConfig() is memoized upstream.
  // Retained as a no-op seam so call sites stay stable across refactors.
}

// ============================================================================
// Command-shell bridge (W3 boundary: src/commands/skill-doctor/engine.ts)
// ============================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Adapts the four-category report engine onto the `SkillDoctorEngine`
 * interface the /skill-doctor command shell consumes
 * (`src/commands/skill-doctor/engine.ts` — W3, command side owns that file).
 * `runSkillDoctor` keeps the richer per-bucket report; this adapts its rows
 * into the flattened `SkillUsageRecord[]` shape `listSkillUsage()` returns,
 * so W3 only swaps `stubSkillDoctorEngine` for this factory result.
 */
export function createSkillDoctorEngine(
  loadSkills: () => readonly Command[],
  options?: SkillDoctorOptions,
): SkillDoctorEngine {
  return {
    listSkillUsage(): SkillUsageRecord[] {
      const skills = loadSkills()
      const report = runSkillDoctor(skills, options)
      const now = options?.now ?? Date.now()
      const enabledByName = new Map(
        skills.map(s => [s.name, s.isEnabled?.() ?? true] as const),
      )
      return report.rows.map(row => ({
        name: row.name,
        source: row.source,
        tokenEstimate: row.contextTokens,
        invocations: row.usageCount,
        daysSinceUse:
          row.lastUsedAt === null
            ? null
            : Math.max(0, Math.floor((now - row.lastUsedAt) / MS_PER_DAY)),
        enabled: enabledByName.get(row.name) ?? true,
      }))
    },
  }
}
