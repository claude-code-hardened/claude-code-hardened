import figures from 'figures';
import * as React from 'react';
import { useEffect } from 'react';
import { Box, Text } from '@anthropic/ink';
import { errorMessage } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { t } from '../../i18n/index.js';
import { validateManifest } from '../../utils/plugins/validatePlugin.js';
import { plural } from '../../utils/stringUtils.js';

type Props = {
  onComplete: (result?: string) => void;
  path?: string;
};

export function ValidatePlugin({ onComplete, path }: Props): React.ReactNode {
  useEffect(() => {
    async function runValidation() {
      // If no path provided, show usage
      if (!path) {
        onComplete(
          t(
            'Usage: /plugin validate <path>\n\nValidate a plugin or marketplace manifest file or directory.\n\nExamples:\n  /plugin validate .claude-plugin/plugin.json\n  /plugin validate /path/to/plugin-directory\n  /plugin validate .\n\nWhen given a directory, automatically validates .claude-plugin/marketplace.json\nor .claude-plugin/plugin.json (prefers marketplace if both exist).\n\nOr from the command line:\n  claude plugin validate <path>',
          ),
        );
        return;
      }

      try {
        const result = await validateManifest(path);

        let output = '';

        // Add header
        output += t('Validating {{type}} manifest: {{path}}\n\n', {
          type: result.fileType,
          path: result.filePath,
        });

        // Show errors
        if (result.errors.length > 0) {
          output += `${figures.cross} ${t('Found {{count}} {{unit}}:\n\n', {
            count: result.errors.length,
            unit: t(plural(result.errors.length, 'error')),
          })}`;

          result.errors.forEach(error => {
            output += `  ${figures.pointer} ${error.path}: ${error.message}\n`;
          });

          output += '\n';
        }

        // Show warnings
        if (result.warnings.length > 0) {
          output += `${figures.warning} ${t('Found {{count}} {{unit}}:\n\n', {
            count: result.warnings.length,
            unit: t(plural(result.warnings.length, 'warning')),
          })}`;

          result.warnings.forEach(warning => {
            output += `  ${figures.pointer} ${warning.path}: ${warning.message}\n`;
          });

          output += '\n';
        }

        // Show success or failure
        if (result.success) {
          if (result.warnings.length > 0) {
            output += `${figures.tick} ${t('Validation passed with warnings')}\n`;
          } else {
            output += `${figures.tick} ${t('Validation passed')}\n`;
          }

          // Exit with code 0 (success)
          process.exitCode = 0;
        } else {
          output += `${figures.cross} ${t('Validation failed')}\n`;

          // Exit with code 1 (validation failure)
          process.exitCode = 1;
        }

        onComplete(output);
      } catch (error) {
        // Exit with code 2 (unexpected error)
        process.exitCode = 2;

        logError(error);

        onComplete(
          `${figures.cross} ${t('Unexpected error during validation: {{error}}', { error: errorMessage(error) })}`,
        );
      }
    }

    void runValidation();
  }, [onComplete, path]);

  return (
    <Box flexDirection="column">
      <Text>{t('Running validation...')}</Text>
    </Box>
  );
}
