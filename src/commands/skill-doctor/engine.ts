/**
 * W3 task #54 — /skill-doctor rendering surface + shared types.
 *
 * The real usage-sampling engine lives in src/skills/skillDoctor.ts (W5:
 * runSkillDoctor / createSkillDoctorEngine over the global-config skillUsage
 * ledger). This module keeps only the rendering half: the flattened
 * `SkillUsageRecord` shape the command renders, the four-category bucketing,
 * the report formatter, and the argument parser. The stub engine and the
 * "engine not wired" claims are gone — /skill-doctor calls the real engine
 * through createSkillDoctorEngine.
 */

export type SkillUsageRecord = {
  /** Skill command name, as shown in the slash menu. */
  name: string
  /** Where the skill was loaded from (userSettings / projectSettings / plugin / bundled). */
  source: string
  /** Rough context cost of the skill's description, in tokens. */
  tokenEstimate: number
  /** Invocation count this sampling window. */
  invocations: number
  /** Days since last invocation; null when never invoked. */
  daysSinceUse: number | null
  enabled: boolean
}

export const SKILL_DOCTOR_CATEGORIES = [
  {
    key: 'attention',
    label: 'Needs attention',
    hint: 'loaded and enabled but never invoked',
  },
  {
    key: 'disused',
    label: 'Disused',
    hint: 'not invoked in the last 30 days',
  },
  {
    key: 'idle',
    label: 'Idle',
    hint: 'not invoked in the last 7 days',
  },
  {
    key: 'active',
    label: 'Active',
    hint: 'invoked within the last 7 days',
  },
] as const

export type SkillDoctorCategoryKey =
  (typeof SKILL_DOCTOR_CATEGORIES)[number]['key']

export interface SkillDoctorEngine {
  listSkillUsage(): SkillUsageRecord[]
}

/** Fixed fixture data for /skill-doctor demo — preview layout only, never real usage. */
export const SKILL_DOCTOR_SAMPLE: SkillUsageRecord[] = [
  {
    name: 'commit',
    source: 'plugin',
    tokenEstimate: 128,
    invocations: 42,
    daysSinceUse: 0,
    enabled: true,
  },
  {
    name: 'cpd',
    source: 'userSettings',
    tokenEstimate: 96,
    invocations: 3,
    daysSinceUse: 12,
    enabled: true,
  },
  {
    name: 'optimize',
    source: 'projectSettings',
    tokenEstimate: 310,
    invocations: 0,
    daysSinceUse: null,
    enabled: true,
  },
]

export function categorizeSkillUsage(
  record: SkillUsageRecord,
): SkillDoctorCategoryKey {
  if (record.daysSinceUse === null || record.invocations === 0) {
    return 'attention'
  }
  if (record.daysSinceUse > 30) return 'disused'
  if (record.daysSinceUse > 7) return 'idle'
  return 'active'
}

export function formatSkillUsageDetail(record: SkillUsageRecord): string {
  const cost = `~${record.tokenEstimate} tok`
  const usage =
    record.daysSinceUse === null
      ? 'never used'
      : `${record.invocations}x ${record.daysSinceUse === 0 ? 'today' : `${record.daysSinceUse}d`}`
  return `${cost} · ${usage}`
}

export function formatSkillDoctorReport(records: SkillUsageRecord[]): string {
  if (records.length === 0) {
    return [
      '## Skill doctor',
      '',
      'No skills loaded (or none are prompt skills), so there is nothing',
      'to sample. Categories the report checks:',
      ...SKILL_DOCTOR_CATEGORIES.map(c => `  - ${c.label}: ${c.hint}`),
    ].join('\n')
  }
  const lines: string[] = ['## Skill doctor', '']
  for (const category of SKILL_DOCTOR_CATEGORIES) {
    const bucket = records.filter(r => categorizeSkillUsage(r) === category.key)
    if (bucket.length === 0) continue
    lines.push(`### ${category.label} (${category.hint})`)
    for (const record of bucket) {
      lines.push(
        `  ${record.name} [${record.source}]${record.enabled ? '' : ' (disabled)'}`,
      )
      lines.push(`    ${formatSkillUsageDetail(record)}`)
    }
    lines.push('')
  }
  const totalCount = records.reduce((sum, r) => sum + r.invocations, 0)
  lines.push(
    `Total ${totalCount} ${totalCount === 1 ? 'use' : 'uses'} across ${records.length} ${records.length === 1 ? 'skill' : 'skills'}`,
  )
  return lines.join('\n').trimEnd()
}

/** Parse /skill-doctor args: `` | `demo` | `help` | unknown. */
export type SkillDoctorArgs =
  | { action: 'run' }
  | { action: 'demo' }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const SKILL_DOCTOR_USAGE =
  'Usage: /skill-doctor [demo] — show which loaded skills are unused and costing context'

export function parseSkillDoctorArgs(raw: string): SkillDoctorArgs {
  const sub = raw.trim().toLowerCase()
  if (sub === '') return { action: 'run' }
  if (sub === 'demo') return { action: 'demo' }
  if (sub === 'help') return { action: 'help' }
  return { action: 'invalid', error: `Unknown argument: "${sub}"` }
}
