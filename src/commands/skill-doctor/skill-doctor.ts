/**
 * W3 task #54 — /skill-doctor command shell.
 *
 * Upstream (2.1.284): local-jsx UI over a skill-usage sampler. The command
 * now calls the real engine — `createSkillDoctorEngine` from
 * src/skills/skillDoctor.ts (W5) — over the caller's loaded command list
 * (context.options.commands), so the report reflects actual skill usage
 * from the global-config ledger. `demo` renders a fixed fixture with an
 * explicit DEMO watermark (not real usage).
 */

import type {
  LocalCommandCall,
  LocalCommandResult,
} from '../../types/command.js'
import {
  createSkillDoctorEngine,
  runSkillDoctor,
} from '../../skills/skillDoctor.js'
import {
  SKILL_DOCTOR_SAMPLE,
  SKILL_DOCTOR_USAGE,
  formatSkillDoctorBuckets,
  formatSkillDoctorReport,
  parseSkillDoctorArgs,
} from './engine.js'

const DEMO_WATERMARK = [
  '',
  '--- DEMO DATA — fixed fixture, not real usage from this session ---',
]

export const call: LocalCommandCall = async (rawArgs, context) => {
  const args = parseSkillDoctorArgs(rawArgs)
  switch (args.action) {
    case 'run': {
      // Real engine over the loaded command registry (skills only — prompt
      // commands). Usage comes from the global-config skillUsage ledger.
      // Both doctor engines render: the recency categories (engine.ts) over
      // the flattened records, plus the official loaded-from four buckets
      // (skillDoctor.ts doctorCategory, fix-item 7) from the report — one
      // shared `now` keeps both views on the same 7-day window.
      const now = Date.now()
      const report = runSkillDoctor(context.options.commands, { now })
      const engine = createSkillDoctorEngine(() => context.options.commands, {
        now,
      })
      const records = engine.listSkillUsage()
      const sections = [formatSkillDoctorReport(records)]
      const buckets = formatSkillDoctorBuckets(report)
      if (buckets) sections.push(buckets)
      if (report.weekTokensNote) sections.push(report.weekTokensNote)
      return { type: 'text', value: sections.join('\n\n') }
    }
    case 'demo':
      // Sample fixture data so the four-category layout can be reviewed.
      // Not real usage — explicitly watermarked as DEMO.
      return {
        type: 'text',
        value: [
          formatSkillDoctorReport(SKILL_DOCTOR_SAMPLE),
          ...DEMO_WATERMARK,
        ].join('\n'),
      }
    case 'help':
      return { type: 'text', value: SKILL_DOCTOR_USAGE }
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', SKILL_DOCTOR_USAGE].join('\n'),
      }
  }
  // Exhaustiveness guard (never reached with the current union).
  const unreachable: never = args
  return unreachable as unknown as LocalCommandResult
}
