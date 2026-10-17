// Auto-generated stub — replace with real implementation
// CCH: storage layer intentionally NOT implemented (half-finished module —
// see src/services/contextCollapse/index.ts). Fail loudly if the feature gate
// is force-enabled so the disabled-by-default flag (scripts/defines.ts) can
// never silently activate a no-storage collapse pipeline.
import { feature } from 'bun:bundle'

function assertStorageImplemented(): void {
  if (feature('CONTEXT_COLLAPSE')) {
    throw new Error(
      'CONTEXT_COLLAPSE storage is not implemented in this build: restoreFromEntries ' +
        'cannot restore collapsed messages. Remove FEATURE_CONTEXT_COLLAPSE=1 ' +
        '(see scripts/defines.ts) or implement the storage layer first.',
    )
  }
}

export const restoreFromEntries: (...args: unknown[]) => void = () => {
  assertStorageImplemented()
}
