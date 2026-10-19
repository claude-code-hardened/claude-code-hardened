import * as React from 'react'
import type { Command } from '../../types/command.js'
import { logForDebugging } from '../../utils/debug.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import { estimateSkillFrontmatterTokens } from '../../skills/loadSkillsDir.js'
import {
  buildSkillIdentifier,
  fetchSkillHealthIfEnabled,
  getSkillsApiBase,
  isSkillsSyncEnabled,
} from '../../skills/syncedSkills.js'

/**
 * Skills Dashboard — data surface for the claude.ai skills health panel
 * (upstream anchor 0025 module-003 :915: GET /api/claude_code/skills returns
 * `{ skills: [{ skill_name, health }] }`, degraded to no health data on any
 * failure). Cloud health is feature-gated on SKILLS_SYNC (default OFF); the
 * dashboard itself always renders local registry data.
 */

export type SkillHealthStatus = string

/** Per-command row the dashboard renders (渲染命令数据结构). */
export type SkillsDashboardRow = {
  identifier: string
  name: string
  displayName: string
  source: string
  loadedFrom: string
  argumentHint: string | undefined
  description: string
  /** Estimated tokens this skill adds to the system prompt every turn. */
  contextTokens: number
  /** Cloud health from GET /api/claude_code/skills; null when unavailable. */
  health: SkillHealthStatus | null
}

export type SkillsDashboardState = 'loading' | 'ready' | 'error'

export type SkillsDashboardData = {
  state: SkillsDashboardState
  rows: SkillsDashboardRow[]
  error: string | null
  /** True when cloud health was fetched (SKILLS_SYNC gate was open). */
  cloudHealthEnabled: boolean
  apiBase: string
}

export type UseSkillsDashboardOptions = {
  /** Skill source override. Defaults to the full command registry. */
  getSkills?: () => Promise<Command[]> | Command[]
  /** Fetch client override (tests). */
  fetchImpl?: typeof fetch
}

/**
 * Assembles dashboard rows from loaded skills plus (optional) cloud health.
 * Pure — exported for tests and for W3 command shells that pre-compute.
 */
export function buildDashboardRows(
  skills: readonly Command[],
  healthBySkill: ReadonlyMap<string, SkillHealthStatus> = new Map(),
): SkillsDashboardRow[] {
  const rows: SkillsDashboardRow[] = []
  for (const skill of skills) {
    if (skill.type !== 'prompt') continue
    rows.push({
      identifier: buildSkillIdentifier(skill),
      name: skill.name,
      displayName: skill.userFacingName?.() ?? skill.name,
      source: String(skill.source),
      loadedFrom: skill.loadedFrom ?? 'skills',
      argumentHint: skill.argumentHint,
      description: skill.description,
      contextTokens: estimateSkillFrontmatterTokens(skill),
      health: healthBySkill.get(skill.name) ?? null,
    })
  }
  rows.sort(
    (a, b) => a.name.localeCompare(b.name) || b.contextTokens - a.contextTokens,
  )
  return rows
}

// Lazy: pulls the full command registry only when the default accessor
// actually runs (dashboards with an injected getSkills never pay for it).
async function defaultGetSkills(): Promise<Command[]> {
  const { getCommands } = await import('../../commands.js')
  return getCommands(getProjectRoot())
}

/**
 * `useSkillsDashboard` — loads the skill registry, merges cloud skill health
 * when the SKILLS_SYNC feature gate is open (default off — no network), and
 * exposes the render-ready rows.
 */
export function useSkillsDashboard(
  options?: UseSkillsDashboardOptions,
): SkillsDashboardData & { refresh: () => void } {
  // Keep the latest accessor in a ref so refresh() always re-runs with the
  // caller's current getter without forcing a reload on identity churn.
  const optionsRef = React.useRef(options)
  optionsRef.current = options

  const [rows, setRows] = React.useState<SkillsDashboardRow[]>([])
  const [state, setState] = React.useState<SkillsDashboardState>('loading')
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)

  const refresh = React.useCallback(() => {
    setReloadToken(t => t + 1)
  }, [])

  React.useEffect(() => {
    let cancelled = false
    const opts = optionsRef.current
    const loadSkills = opts?.getSkills ?? defaultGetSkills
    async function load(): Promise<void> {
      setState('loading')
      try {
        const commands = await Promise.resolve(loadSkills())
        const health = await fetchSkillHealthIfEnabled({
          fetchImpl: opts?.fetchImpl,
        })
        if (cancelled) return
        setRows(buildDashboardRows(commands, health))
        setError(null)
        setState('ready')
      } catch (e: unknown) {
        if (cancelled) return
        const message = e instanceof Error ? e.message : String(e)
        logForDebugging(`[skills-dashboard] load failed: ${message}`)
        setError(message)
        setState('error')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  return {
    state,
    rows,
    error,
    // Whether the cloud health face was allowed by the SKILLS_SYNC gate.
    // Feature-off (default) means rows carry health: null and no fetch ran.
    cloudHealthEnabled: isSkillsSyncEnabled(),
    apiBase: getSkillsApiBase(),
    refresh,
  }
}
