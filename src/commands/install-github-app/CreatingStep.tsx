import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';
import type { Workflow } from './types.js';

interface CreatingStepProps {
  currentWorkflowInstallStep: number;
  secretExists: boolean;
  useExistingSecret: boolean;
  secretName: string;
  skipWorkflow?: boolean;
  selectedWorkflows: Workflow[];
}

export function CreatingStep({
  currentWorkflowInstallStep,
  secretExists,
  useExistingSecret,
  secretName,
  skipWorkflow = false,
  selectedWorkflows,
}: CreatingStepProps) {
  const progressSteps = skipWorkflow
    ? [
        t('Getting repository information'),
        secretExists && useExistingSecret
          ? t('Using existing API key secret')
          : t('Setting up {{name}} secret', { name: secretName }),
      ]
    : [
        t('Getting repository information'),
        t('Creating branch'),
        selectedWorkflows.length > 1 ? t('Creating workflow files') : t('Creating workflow file'),
        secretExists && useExistingSecret
          ? t('Using existing API key secret')
          : t('Setting up {{name}} secret', { name: secretName }),
        t('Opening pull request page'),
      ];

  return (
    <>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{t('Install GitHub App')}</Text>
          <Text dimColor>{t('Create GitHub Actions workflow')}</Text>
        </Box>
        {progressSteps.map((stepText, index) => {
          let status: 'completed' | 'in-progress' | 'pending' = 'pending';

          if (index < currentWorkflowInstallStep) {
            status = 'completed';
          } else if (index === currentWorkflowInstallStep) {
            status = 'in-progress';
          }

          return (
            <Box key={index}>
              <Text color={status === 'completed' ? 'success' : status === 'in-progress' ? 'warning' : undefined}>
                {status === 'completed' ? '✓ ' : ''}
                {stepText}
                {status === 'in-progress' ? '…' : ''}
              </Text>
            </Box>
          );
        })}
      </Box>
    </>
  );
}
