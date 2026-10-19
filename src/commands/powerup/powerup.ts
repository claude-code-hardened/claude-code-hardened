/**
 * W3 task #54 — /powerup: static step-by-step course checklist.
 *
 * Honesty note: the previous "claim / balance" accounting (powerups.json)
 * was fictional — nothing consumed the balance and no rate-limit track
 * existed to wire a consumer. This build replaces it with the honest
 * surface: a fixed list of course steps printed on every invocation.
 * No persistence, no counters, nothing to claim or spend.
 */

import type { LocalCommandCall } from '../../types/command.js'
import { POWERUP_USAGE, parsePowerupArgs } from './args.js'

export interface PowerupCourseStep {
  step: number
  title: string
  detail: string
}

export const POWERUP_COURSE: PowerupCourseStep[] = [
  {
    step: 1,
    title: 'Orient the model',
    detail:
      'Run /init to scaffold CLAUDE.md, then keep editing it — it steers every session in this repo.',
  },
  {
    step: 2,
    title: 'Plan before multi-file work',
    detail:
      'Cycle into plan mode (shift+tab) so file edits wait for your approval of the plan.',
  },
  {
    step: 3,
    title: 'Watch the context budget',
    detail:
      '/context shows what fills the window; /compact summarizes when it gets tight.',
  },
  {
    step: 4,
    title: 'Automate the gates',
    detail:
      'Hooks run on tool events — format, lint, or block edits without being asked each time.',
  },
  {
    step: 5,
    title: 'Extend the toolset',
    detail:
      '/mcp connects external tool servers; /agents manages subagent definitions.',
  },
  {
    step: 6,
    title: 'Review before you ship',
    detail:
      '/review audits a diff; security-review scans it for vulnerabilities.',
  },
]

/** Pure formatter for the static course checklist. */
export function formatPowerupCourse(): string {
  return [
    '## Powerup course — level up step by step',
    '',
    ...POWERUP_COURSE.map(
      step => `  ${step.step}. ${step.title}\n     ${step.detail}`,
    ),
    '',
    'Static checklist — no counters, no balance, nothing to claim.',
  ].join('\n')
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parsePowerupArgs(rawArgs)
  switch (args.action) {
    case 'show':
      return { type: 'text', value: formatPowerupCourse() }
    case 'help':
      return { type: 'text', value: POWERUP_USAGE }
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', POWERUP_USAGE].join('\n'),
      }
  }
}
