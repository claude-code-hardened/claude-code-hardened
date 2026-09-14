import type {
  SessionModeState,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'
// SDK 1.x removed `SessionModelState`; the local type in sessionTypes.ts
// preserves the model-selection concept that feeds the 'model' config option.
import type { SessionModelState } from './sessionTypes.js'

export function buildConfigOptions(
  modes: SessionModeState,
  models: SessionModelState,
): SessionConfigOption[] {
  return [
    {
      id: 'mode',
      name: 'Mode',
      description: 'Session permission mode',
      category: 'mode',
      type: 'select' as const,
      currentValue: modes.currentModeId,
      options: modes.availableModes.map(
        (m: SessionModeState['availableModes'][number]) => ({
          value: m.id,
          name: m.name,
          description: m.description,
        }),
      ),
    },
    {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select' as const,
      currentValue: models.currentModelId,
      options: models.availableModels.map(
        (m: SessionModelState['availableModels'][number]) => ({
          value: m.modelId,
          name: m.name,
          description: m.description ?? undefined,
        }),
      ),
    },
  ] as SessionConfigOption[]
}

/**
 * Flatten a SessionConfigOption's `options` (which may be flat
 * SessionConfigSelectOption entries or grouped SessionConfigSelectGroup
 * entries) into a list of valid value strings. Used to validate that a
 * setSessionConfigOption value is one of the listed options.
 */
export function flattenConfigOptionValues(options: unknown): string[] {
  const values: string[] = []
  if (!Array.isArray(options)) return values
  for (const opt of options) {
    if (typeof opt !== 'object' || opt === null) continue
    const maybeGroup = opt as { group?: unknown; options?: unknown[] }
    if (Array.isArray(maybeGroup.options)) {
      // SessionConfigSelectGroup — recurse into its options
      for (const inner of maybeGroup.options) {
        if (
          inner &&
          typeof inner === 'object' &&
          typeof (inner as { value?: unknown }).value === 'string'
        ) {
          values.push((inner as { value: string }).value)
        }
      }
    } else if (typeof (opt as { value?: unknown }).value === 'string') {
      // SessionConfigSelectOption
      values.push((opt as { value: string }).value)
    }
  }
  return values
}
