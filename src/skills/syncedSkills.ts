import { feature } from 'bun:bundle'
import { join } from 'path'
import type { Command, PromptCommand } from '../types/command.js'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { isENOENT, isFsInaccessible } from '../utils/errors.js'
import { getAuthHeaders } from '../utils/http.js'
import { logError } from '../utils/log.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { writeTextContent } from '../utils/file.js'
import {
  createSkillCommand,
  parseSkillFrontmatterFields,
} from './loadSkillsDir.js'

/**
 * syncedSkills — the claude.ai-delivered skill surface.
 *
 * Upstream anchor: docs/reverse-284/decompiled/0025-chunk-m7ywx1p7
 * module-003-uncategorized.js:
 *   Br(a)  → skill identifiers are `synced-skill:${source}:${name}` when
 *            `loadedFrom === 'syncedSkills'`, `skill:${source}:${name}` otherwise.
 *   Ju(a)  → a `synced-skill:` identifier expands to BOTH the `synced-skill:`
 *            and `skill:` alias variants (used for dedupe / menu select).
 *   Rl/Zu  → local-first select merging with alias awareness.
 *
 * Two faces:
 *  - LOCAL: SKILL.md directories under
 *    {@link getSyncedSkillsDir} (`getClaudeConfigHomeDir()/synced-skills/`).
 *    Loading is offline and always available (empty when the dir is absent).
 *  - CLOUD: fetching the skill health/sync surface from claude.ai. Strictly
 *    feature-gated — `feature('SKILLS_SYNC')` defaults OFF (not in
 *    DEFAULT_BUILD_FEATURES), with the API base injectable via
 *    `CLAUDE_CODE_SKILLS_API_BASE` so self-hosted/proxied deployments work.
 */

// ============================================================================
// Identifiers (anchor 0025 module-003 Br/Ju)
// ============================================================================

/** Prefix for skill identifiers originating from the synced (claude.ai) surface. */
export const SYNCED_SKILL_PREFIX = 'synced-skill:'

/** Prefix for skill identifiers originating from any local surface. */
export const SKILL_IDENTIFIER_PREFIX = 'skill:'

/** Directory name under the claude config home holding synced skills. */
export const SYNCED_SKILLS_DIR_NAME = 'synced-skills'

export type SkillIdentifierInput = {
  name: string
  source: string
  loadedFrom?: string
}

/**
 * Stable identifier for a skill, mirroring upstream `Br`:
 * `synced-skill:${source}:${name}` for synced skills,
 * `skill:${source}:${name}` for everything else.
 */
export function buildSkillIdentifier(skill: SkillIdentifierInput): string {
  const prefix =
    skill.loadedFrom === 'syncedSkills'
      ? SYNCED_SKILL_PREFIX
      : SKILL_IDENTIFIER_PREFIX
  return `${prefix}${skill.source}:${skill.name}`
}

export type ParsedSkillIdentifier = {
  prefix: typeof SYNCED_SKILL_PREFIX | typeof SKILL_IDENTIFIER_PREFIX
  source: string
  name: string
}

/**
 * Parses a `skill:` / `synced-skill:` identifier back into its parts.
 * Returns null for foreign strings (not an error — callers skip unknown ids).
 */
export function parseSkillIdentifier(
  identifier: string,
): ParsedSkillIdentifier | null {
  const kind = identifier.startsWith(SYNCED_SKILL_PREFIX)
    ? 'synced-skill:'
    : identifier.startsWith(SKILL_IDENTIFIER_PREFIX)
      ? 'skill:'
      : null
  if (kind === null) return null
  const rest = identifier.slice(kind.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null
  const source = rest.slice(0, sep)
  const name = rest.slice(sep + 1)
  if (!source || !name) return null
  return {
    prefix:
      kind === 'synced-skill:' ? SYNCED_SKILL_PREFIX : SKILL_IDENTIFIER_PREFIX,
    source,
    name,
  }
}

/**
 * Alias variants considered equivalent for dedupe / select toggling,
 * mirroring upstream `Ju`: only `synced-skill:` identifiers expand, and each
 * expands to both its synced and plain skill form. Per the official pass only
 * the NAME segment is case-normalized — `source` is kept verbatim (R5 review:
 * lowercasing the source drifted from upstream `Ju`).
 */
export function getSkillIdentifierAliases(identifier: string): string[] {
  if (!identifier.startsWith(SYNCED_SKILL_PREFIX)) return []
  const parsed = parseSkillIdentifier(identifier)
  if (!parsed) return []
  const normalizedName = parsed.name.toLowerCase()
  return [
    `${SYNCED_SKILL_PREFIX}${parsed.source}:${normalizedName}`,
    `${SKILL_IDENTIFIER_PREFIX}${parsed.source}:${normalizedName}`,
  ]
}

// ============================================================================
// Dedupe + registry merge (anchor 0025 module-003 Rl — local first)
// ============================================================================

function skillIdentifierSet(skills: readonly Command[]): Set<string> {
  const ids = new Set<string>()
  for (const skill of skills) {
    if (skill.type !== 'prompt') continue
    ids.add(buildSkillIdentifier(skill))
  }
  return ids
}

/**
 * Filters synced skills that collide with locally-loaded ones. Local wins:
 * a synced skill is dropped when its plain name, its identifier, or any alias
 * expansion of that identifier collides with an existing local skill
 * (upstream `Rl` select semantics).
 */
export function dedupeSyncedSkills<T extends Command>(
  synced: readonly T[],
  existing: readonly Command[],
): T[] {
  const existingNames = new Set(existing.map(c => c.name))
  const existingIds = skillIdentifierSet(existing)

  return synced.filter(skill => {
    if (skill.type !== 'prompt') return false
    if (existingNames.has(skill.name)) {
      logForDebugging(
        `Skipping synced skill '${skill.name}': a local skill with the same name is loaded (local takes precedence)`,
      )
      return false
    }
    const identifier = buildSkillIdentifier(skill)
    if (existingIds.has(identifier)) {
      logForDebugging(
        `Skipping synced skill '${skill.name}': identifier already loaded locally (${identifier})`,
      )
      return false
    }
    for (const alias of getSkillIdentifierAliases(identifier)) {
      if (existingIds.has(alias)) {
        logForDebugging(
          `Skipping synced skill '${skill.name}': local alias conflict (${alias})`,
        )
        return false
      }
    }
    return true
  })
}

/**
 * Merges a skill registry: local commands first (unchanged), then synced
 * skills that survived dedupe. Import order matters for consumers that read
 * the first match (findCommand), so locals always precede synced entries.
 */
export function mergeSkillRegistry(
  local: readonly Command[],
  synced: readonly Command[],
): Command[] {
  return [...local, ...dedupeSyncedSkills(synced, local)]
}

// ============================================================================
// Local loading: getClaudeConfigHomeDir()/synced-skills/<name>/SKILL.md
// ============================================================================

/**
 * Directory holding claude.ai-synced skills:
 * `<claude config home>/synced-skills/`.
 */
export function getSyncedSkillsDir(): string {
  return join(getClaudeConfigHomeDir(), SYNCED_SKILLS_DIR_NAME)
}

/**
 * Loads synced skills from {@link getSyncedSkillsDir}. Only the directory
 * format is supported (`skill-name/SKILL.md`), matching local /skills/.
 * Synced skills are user-config-home resident, so they are registered with
 * `source: 'userSettings'` and `loadedFrom: 'syncedSkills'` (the marker the
 * rest of the codebase — identifiers, dashboard, doctor — keys off).
 */
export async function loadSyncedSkills(): Promise<Command[]> {
  const syncedDir = getSyncedSkillsDir()
  const fs = getFsImplementation()

  let entries
  try {
    entries = await fs.readdir(syncedDir)
  } catch (e: unknown) {
    if (!isFsInaccessible(e) && !isENOENT(e)) logError(e)
    return []
  }

  const loaded = await Promise.all(
    entries.map(async (entry): Promise<Command | null> => {
      try {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return null

        const skillDirPath = `${syncedDir}/${entry.name}`
        const skillFilePath = `${skillDirPath}/SKILL.md`

        let content: string
        try {
          content = await fs.readFile(skillFilePath, { encoding: 'utf-8' })
        } catch (e: unknown) {
          if (!isENOENT(e)) {
            logForDebugging(
              `[synced-skills] failed to read ${skillFilePath}: ${e}`,
              { level: 'warn' },
            )
          }
          return null
        }

        const { frontmatter, content: markdownContent } = parseFrontmatter(
          content,
          skillFilePath,
        )

        const skillName = entry.name
        // Synced skills have no request path, so they are never conditional
        // on files (paths frontmatter is not honored) and are not model-gated
        // beyond the standard disable-model-invocation flag.
        const parsed = parseSkillFrontmatterFields(
          frontmatter,
          markdownContent,
          skillName,
        )

        return createSkillCommand({
          ...parsed,
          skillName,
          markdownContent,
          source: 'userSettings',
          baseDir: skillDirPath,
          loadedFrom: 'syncedSkills',
          paths: undefined,
        })
      } catch (error) {
        logError(error)
        return null
      }
    }),
  )

  const skills = loaded.filter((s): s is Command => s !== null)
  if (skills.length > 0) {
    logForDebugging(`[synced-skills] Loaded ${skills.length} synced skills`)
  }
  return skills
}

// ============================================================================
// Accepted-ids model (anchor 0025 module-003 Rl/Zu, verbatim functions)
// ============================================================================

/** Filename of the persisted accepted-skill-id set, under the claude config home. */
export const ACCEPTED_SKILL_IDS_FILENAME = 'synced-skills-accepted.json'

/** Shape of the accepted-ids persistence file. `savedAt` is metadata written
 * on every store (hook point for future eviction); the Rl/Zu acceptance model
 * itself does not expire entries — the 0025 anchors carry no TTL semantics. */
export type AcceptedSkillIdsFile = {
  version?: 1
  savedAt?: string
  ids: string[]
}

/** Path of the accepted-ids file: `getClaudeConfigHomeDir()/synced-skills-accepted.json`. */
export function getAcceptedSkillIdsPath(): string {
  return join(getClaudeConfigHomeDir(), ACCEPTED_SKILL_IDS_FILENAME)
}

/**
 * Reads the persisted accepted id set. Degradates to an empty set on ENOENT /
 * unreadable / malformed payloads — acceptance state is advisory, never
 * blocking.
 *
 * WIRING STATUS (honest declaration, fix-item 4): the persisted accept set is
 * NOT consumed by any production surface yet — read/write/toggle are only
 * exercised by tests. The official consumer is the interactive
 * select/deselect UI over the skill list (0025 module-003 `Zu` toggle inside
 * the plugin/skills menu); until a CCH surface both writes the set and gates
 * skill visibility/loading on it, these exports stay intentionally unwired —
 * wiring a write-only toggle would persist state nothing reads.
 */
export async function readAcceptedSkillIds(): Promise<Set<string>> {
  const fs = getFsImplementation()
  let raw: string
  try {
    raw = await fs.readFile(getAcceptedSkillIdsPath(), { encoding: 'utf-8' })
  } catch (e: unknown) {
    if (!isENOENT(e) && !isFsInaccessible(e)) logError(e)
    return new Set()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AcceptedSkillIdsFile>
    if (!Array.isArray(parsed?.ids)) return new Set()
    return new Set(
      parsed.ids.filter((id): id is string => typeof id === 'string'),
    )
  } catch (e: unknown) {
    logForDebugging(`[synced-skills] accepted-ids file unreadable: ${e}`)
    return new Set()
  }
}

/** Persists the accepted id set (sync write with the shared flush+atomic path). */
export function writeAcceptedSkillIdsSync(ids: ReadonlySet<string>): void {
  const payload: AcceptedSkillIdsFile = {
    version: 1,
    savedAt: new Date().toISOString(),
    ids: [...ids],
  }
  writeTextContent(
    getAcceptedSkillIdsPath(),
    JSON.stringify(payload, null, 2),
    'utf8',
    'LF',
  )
}

/**
 * Effective accepted/id-mark set — verbatim port of official `Rl` (0025
 * module-003): `function Rl(a,h){let k=new Set,b=[];for(let P of h){let R=Br(P);
 * if(P.loadedFrom==="syncedSkills")b.push(R);else k.add(R)}let v=null;
 * for(let P of b){if(a.has(P))continue;for(let R of Ju(P))
 * if(a.has(R)&&!k.has(R)){v??=new Set(a),v.add(P);break}}return v??a}`
 *
 * A synced id not yet in the set is migrated-in when an alias expansion
 * (`skill:` form) is already accepted AND that alias is not occupied by a
 * local skill — local (non-synced) ids block the migration. Non-mutating:
 * returns the input set identity when nothing migrates.
 */
export function computeEffectiveAcceptedSkillIds(
  accepted: ReadonlySet<string>,
  skills: readonly SkillIdentifierInput[],
): ReadonlySet<string> {
  const localIds = new Set<string>()
  const syncedIds: string[] = []
  for (const skill of skills) {
    const id = buildSkillIdentifier(skill)
    if (id.startsWith(SYNCED_SKILL_PREFIX)) syncedIds.push(id)
    else localIds.add(id)
  }
  let updated: Set<string> | null = null
  for (const id of syncedIds) {
    if (accepted.has(id)) continue
    for (const alias of getSkillIdentifierAliases(id)) {
      if (accepted.has(alias) && !localIds.has(alias)) {
        updated ??= new Set(accepted)
        updated.add(id)
        break
      }
    }
  }
  return updated ?? accepted
}

/**
 * Toggle a skill id in the accepted set — verbatim port of official `Zu`
 * (0025 module-003): `function Zu(a,h,k){let b=Rl(a,k),v=new Set(a);
 * if(!b.has(h))return v.add(h),v;v.delete(h);
 * for(let P of Ju(h))if(!k.some((R)=>R.loadedFrom!=="syncedSkills"&&Br(R)===P))
 * v.delete(P);return v}`
 *
 * Toggle-on adds the id. Toggle-off removes it AND its alias expansions —
 * except an alias that a local skill occupies, so a local skill and its
 * same-name synced sibling keep co-existing as distinct ids in the set.
 *
 * WIRING STATUS: test-only today (see readAcceptedSkillIds above) — no
 * production UI calls this until a gating consumer exists.
 */
export function toggleAcceptedSkillId(
  accepted: ReadonlySet<string>,
  identifier: string,
  skills: readonly SkillIdentifierInput[],
): Set<string> {
  const effective = computeEffectiveAcceptedSkillIds(accepted, skills)
  const next = new Set(accepted)
  if (!effective.has(identifier)) {
    next.add(identifier)
    return next
  }
  next.delete(identifier)
  for (const alias of getSkillIdentifierAliases(identifier)) {
    const occupiedByLocal = skills.some(
      skill =>
        !String(buildSkillIdentifier(skill)).startsWith(SYNCED_SKILL_PREFIX) &&
        buildSkillIdentifier(skill) === alias,
    )
    if (!occupiedByLocal) {
      next.delete(alias)
    }
  }
  return next
}

// ============================================================================
// Cloud surface — feature-gated (SKILLS_SYNC), default OFF
// ============================================================================

/** Env var overriding the claude.ai API base for the synced-skills surface. */
export const SKILLS_API_BASE_ENV = 'CLAUDE_CODE_SKILLS_API_BASE'

const DEFAULT_SKILLS_API_BASE = 'https://claude.ai'

/**
 * Whether the cloud pull face may run at all. Strictly gated on the
 * SKILLS_SYNC build feature — which is intentionally NOT in
 * DEFAULT_BUILD_FEATURES, so every cloud dependency here is off by default.
 */
export function isSkillsSyncEnabled(): boolean {
  if (feature('SKILLS_SYNC')) return true
  return false
}

/**
 * API base URL for the claude_code skills surface. Cloud deploys inject via
 * `CLAUDE_CODE_SKILLS_API_BASE` (self-hosted proxies / W3 command shells);
 * defaults to claude.ai.
 */
export function getSkillsApiBase(): string {
  const fromEnv = process.env[SKILLS_API_BASE_ENV]
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.replace(/\/+$/, '')
  }
  return DEFAULT_SKILLS_API_BASE
}

/** Typed response of GET {base}/api/claude_code/skills (anchor 0025 :915). */
export type SkillsHealthResponse = {
  skills?: {
    skill_name?: unknown
    health?: unknown
  }[]
}

/**
 * Fetches per-skill health from `{base}/api/claude_code/skills`.
 * Mirrors upstream `ry`: invalid payloads and transport failures degrade to an
 * empty map (health is always advisory — never blocking).
 *
 * Auth: reuses the shared claude.ai header builder ({@link getAuthHeaders} —
 * OAuth Bearer + anthropic-beta for subscribers, x-api-key otherwise). When
 * no credential is available the request still goes out unauthenticated and
 * a 401 falls into the non-ok degrade path below (R5: header reuse keeps this
 * surface consistent with metricsOptOut/bigqueryExporter). `authHeaders` is a
 * test/proxy injection seam mirroring fetchImpl — when given, it replaces the
 * getAuthHeaders() result wholesale.
 *
 * The caller MUST gate on {@link isSkillsSyncEnabled} — this function performs
 * no gating itself so tests can exercise the client directly.
 */
export async function fetchSkillHealth(options?: {
  base?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  authHeaders?: Record<string, string>
}): Promise<Map<string, string>> {
  const doFetch = options?.fetchImpl ?? fetch
  const base = options?.base ?? getSkillsApiBase()
  const timeoutMs = options?.timeoutMs ?? 5_000

  const authResult = options?.authHeaders
    ? { headers: options.authHeaders, error: undefined }
    : getAuthHeaders()
  if (authResult.error) {
    logForDebugging(
      `[synced-skills] Skill health fetch skipped: ${authResult.error}`,
      { level: 'warn' },
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await doFetch(`${base}/api/claude_code/skills`, {
      headers: {
        'Content-Type': 'application/json',
        ...authResult.headers,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      logForDebugging(
        response.status === 401 || response.status === 403
          ? `[synced-skills] Skill health fetch skipped: auth rejected (status ${response.status}) — health shown as unavailable`
          : `[synced-skills] Skill health fetch skipped: status ${response.status}`,
        { level: 'warn' },
      )
      return new Map()
    }
    const data = (await response.json()) as SkillsHealthResponse
    if (!Array.isArray(data?.skills)) return new Map()

    const healthBySkill = new Map<string, string>()
    for (const entry of data.skills) {
      if (
        typeof entry?.skill_name === 'string' &&
        entry.skill_name.length > 0 &&
        typeof entry?.health === 'string'
      ) {
        healthBySkill.set(entry.skill_name, entry.health)
      }
    }
    return healthBySkill
  } catch (e: unknown) {
    logForDebugging(`[synced-skills] Skill health fetch skipped: ${e}`, {
      level: 'warn',
    })
    return new Map()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Convenience wrapper used by UI faces: fetches skill health only when the
 * SKILLS_SYNC feature gate is on; otherwise returns an empty map without any
 * network activity. Feature-off is the default in every build and test env.
 * `gateOverride` is a test seam that forces the on-path (the off-path default
 * is pinned by syncedSkills.test.ts) without re-mocking bun:bundle — which is
 * process-global in bun:test and races across files in the same directory.
 */
export async function fetchSkillHealthIfEnabled(options?: {
  base?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  authHeaders?: Record<string, string>
  /** Test seam — force the gate decision instead of isSkillsSyncEnabled(). */
  gateOverride?: boolean
}): Promise<Map<string, string>> {
  const enabled = options?.gateOverride ?? isSkillsSyncEnabled()
  if (!enabled) return new Map()
  return fetchSkillHealth(options)
}

/**
 * True when a synced skill command should be surfaced as claude.ai-managed.
 * Kept as a predicate (not a cast) so callers never rely on string literals.
 */
export function isSyncedSkill(
  command: Command,
): command is Command & PromptCommand {
  return command.type === 'prompt' && command.loadedFrom === 'syncedSkills'
}

// Re-exported for W3 command shells so they never import the raw constants.
