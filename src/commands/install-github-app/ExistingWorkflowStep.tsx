import { Select } from 'src/components/CustomSelect/index.js';
import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';

interface ExistingWorkflowStepProps {
  repoName: string;
  onSelectAction: (action: 'update' | 'skip' | 'exit') => void;
}

export function ExistingWorkflowStep({ repoName, onSelectAction }: ExistingWorkflowStepProps) {
  const options = [
    {
      label: t('Update workflow file with latest version'),
      value: 'update',
    },
    {
      label: t('Skip workflow update (configure secrets only)'),
      value: 'skip',
    },
    {
      label: t('Exit without making changes'),
      value: 'exit',
    },
  ];

  const handleSelect = (value: string) => {
    onSelectAction(value as 'update' | 'skip' | 'exit');
  };

  const handleCancel = () => {
    onSelectAction('exit');
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{t('Existing Workflow Found')}</Text>
        <Text dimColor>{t('Repository: {{repo}}', { repo: repoName })}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text>
          {t('A Claude workflow file already exists at ')}
          <Text color="claude">.github/workflows/claude.yml</Text>
        </Text>
        <Text dimColor>{t('What would you like to do?')}</Text>
      </Box>

      <Box flexDirection="column">
        <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {t('View the latest workflow template at:')}{' '}
          <Text color="claude">https://github.com/anthropics/claude-code-action/blob/main/examples/claude.yml</Text>
        </Text>
      </Box>
    </Box>
  );
}
