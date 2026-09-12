import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';

type SuccessStepProps = {
  secretExists: boolean;
  useExistingSecret: boolean;
  secretName: string;
  skipWorkflow?: boolean;
};

export function SuccessStep({
  secretExists,
  useExistingSecret,
  secretName,
  skipWorkflow = false,
}: SuccessStepProps): React.ReactNode {
  return (
    <>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{t('Install GitHub App')}</Text>
          <Text dimColor>{t('Success')}</Text>
        </Box>
        {!skipWorkflow && <Text color="success">{t('✓ GitHub Actions workflow created!')}</Text>}
        {secretExists && useExistingSecret && (
          <Box marginTop={1}>
            <Text color="success">{t('✓ Using existing ANTHROPIC_API_KEY secret')}</Text>
          </Box>
        )}
        {(!secretExists || !useExistingSecret) && (
          <Box marginTop={1}>
            <Text color="success">{t('✓ API key saved as {{name}} secret', { name: secretName })}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text>{t('Next steps:')}</Text>
        </Box>
        {skipWorkflow ? (
          <>
            <Text>{t("1. Install the Claude GitHub App if you haven't already")}</Text>
            <Text>{t('2. Your workflow file was kept unchanged')}</Text>
            <Text>{t('3. API key is configured and ready to use')}</Text>
          </>
        ) : (
          <>
            <Text>{t('1. A pre-filled PR page has been created')}</Text>
            <Text>{t("2. Install the Claude GitHub App if you haven't already")}</Text>
            <Text>{t('3. Merge the PR to enable Claude PR assistance')}</Text>
          </>
        )}
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>{t('Press any key to exit')}</Text>
      </Box>
    </>
  );
}
