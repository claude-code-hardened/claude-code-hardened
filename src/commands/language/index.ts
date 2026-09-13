import type { Command } from '../../commands.js'

const language = {
  type: 'local-jsx',
  name: 'language',
  description: 'Set the UI display language',
  load: () => import('./language.js'),
} satisfies Command

export default language
