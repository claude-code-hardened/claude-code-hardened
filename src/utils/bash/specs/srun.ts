import { t } from '../../../i18n/index.js'
import type { CommandSpec } from '../registry.js'

const srun: CommandSpec = {
  name: 'srun',
  description: 'Run a command on SLURM cluster nodes',
  options: [
    {
      name: ['-n', '--ntasks'],
      description: t('Number of tasks'),
      args: {
        name: 'count',
        description: t('Number of tasks to run'),
      },
    },
    {
      name: ['-N', '--nodes'],
      description: t('Number of nodes'),
      args: {
        name: 'count',
        description: t('Number of nodes to allocate'),
      },
    },
  ],
  args: {
    name: 'command',
    description: t('Command to run on the cluster'),
    isCommand: true,
  },
}

export default srun
