import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { SkillsDashboard } from './SkillsDashboard.js';

/**
 * /skills-dashboard local-jsx shell (W5 #56) — renders the skills health
 * panel over the live registry. Registration lives in index.ts; see the
 * wire-up note there.
 */
export async function call(_onDone: LocalJSXCommandOnDone, _context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return <SkillsDashboard />;
}
