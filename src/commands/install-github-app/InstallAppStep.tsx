import figures from 'figures';
import { GITHUB_ACTION_SETUP_DOCS_URL } from '../../constants/github-app.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { t } from '../../i18n/index.js';

interface InstallAppStepProps {
  repoUrl: string;
  onSubmit: () => void;
}

export function InstallAppStep({ repoUrl, onSubmit }: InstallAppStepProps) {
  // Enter to submit
  useKeybinding('confirm:yes', onSubmit, { context: 'Confirmation' });

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{t('Install the Claude GitHub App')}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>{t('Opening browser to install the Claude GitHub App…')}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>{t("If your browser doesn't open automatically, visit:")}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text underline>https://github.com/apps/claude</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          {t('Please install the app for repository: ')}
          <Text bold>{repoUrl}</Text>
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{t('Important: Make sure to grant access to this specific repository')}</Text>
      </Box>
      <Box>
        <Text bold color="permission">
          {t("Press Enter once you've installed the app")}
          {figures.ellipsis}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {t('Having trouble? See manual setup instructions at: ')}
          <Text color="claude">{GITHUB_ACTION_SETUP_DOCS_URL}</Text>
        </Text>
      </Box>
    </Box>
  );
}
