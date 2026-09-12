import { t } from '../../i18n/index.js';
import { Text } from '@anthropic/ink';

export function CheckGitHubStep() {
  return <Text>{t('Checking GitHub CLI installation…')}</Text>;
}
