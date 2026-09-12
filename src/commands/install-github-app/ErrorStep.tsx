import { GITHUB_ACTION_SETUP_DOCS_URL } from '../../constants/github-app.js';
import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';

interface ErrorStepProps {
  error: string | undefined;
  errorReason?: string;
  errorInstructions?: string[];
}

export function ErrorStep({ error, errorReason, errorInstructions }: ErrorStepProps) {
  return (
    <>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{t('Install GitHub App')}</Text>
        </Box>
        <Text color="error">
          {t('Error: ')}
          {error}
        </Text>
        {errorReason && (
          <Box marginTop={1}>
            <Text dimColor>{t('Reason: {{reason}}', { reason: errorReason })}</Text>
          </Box>
        )}
        {errorInstructions && errorInstructions.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{t('How to fix:')}</Text>
            {errorInstructions.map((instruction, index) => (
              <Box key={index} marginLeft={2}>
                <Text dimColor>• </Text>
                <Text>{instruction}</Text>
              </Box>
            ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>
            {t('For manual setup instructions, see: ')}
            <Text color="claude">{GITHUB_ACTION_SETUP_DOCS_URL}</Text>
          </Text>
        </Box>
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>{t('Press any key to exit')}</Text>
      </Box>
    </>
  );
}
