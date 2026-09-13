// Re-export from @anthropic/ink keybindings module.
// Imported via the deep source path instead of the @anthropic/ink barrel:
// the barrel evaluates the whole Ink framework (react-reconciler, yoga),
// and this module is part of main.tsx's pre-commander evaluation closure
// (commands/keybindings -> loadUserBindings). The re-exported functions are
// the exact same bindings the barrel exposes.
export {
  parseKeystroke,
  parseChord,
  keystrokeToString,
  chordToString,
  keystrokeToDisplayString,
  chordToDisplayString,
  parseBindings,
} from '../../../packages/@ant/ink/src/keybindings/parser.js'
