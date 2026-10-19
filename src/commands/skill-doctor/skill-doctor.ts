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
import { createSkillDoctorEngine } from '../../skills/skillDoctor.js'
import {
  SKILL_DOCTOR_SAMPLE,
  SKILL_DOCTOR_USAGE,
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
      const engine = createSkillDoctorEngine(() => context.options.commands)
      const records = engine.listSkillUsage()
      return { type: 'text', value: formatSkillDoctorReport(records) }
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
