// Re-export from @anthropic/ink keybindings module.
// Imported via the deep source path instead of the @anthropic/ink barrel:
// the barrel evaluates the whole Ink framework (react-reconciler, yoga),
// and this module is part of main.tsx's pre-commander evaluation closure
// (query/stopHooks -> shortcutFormat -> resolver). These are the exact same
// bindings the barrel exposes.
export {
  resolveKey,
  resolveKeyWithChordState,
  getBindingDisplayText,
  keystrokesEqual,
  type ResolveResult,
  type ChordResolveResult,
} from '../../packages/@ant/ink/src/keybindings/resolver.js'
