import figures from 'figures';
import React, { useEffect, useState } from 'react';
import { Box, Text, Dialog } from '@anthropic/ink';
import { logForDebugging } from '../utils/debug.js';
import type { GitFileStatus } from '../utils/git.js';
import { getFileStatus, stashToCleanState } from '../utils/git.js';
import { Select } from './CustomSelect/index.js';
import { Spinner } from './Spinner.js';
import { t } from '../i18n/index.js';

type TeleportStashProps = {
  onStashAndContinue: () => void;
  onCancel: () => void;
};

export function TeleportStash({ onStashAndContinue, onCancel }: TeleportStashProps): React.ReactNode {
  const [gitFileStatus, setGitFileStatus] = useState<GitFileStatus | null>(null);
  const changedFiles = gitFileStatus !== null ? [...gitFileStatus.tracked, ...gitFileStatus.untracked] : [];
  const [loading, setLoading] = useState(true);
  const [stashing, setStashing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load changed files on mount
  useEffect(() => {
    const loadChangedFiles = async () => {
      try {
        const fileStatus = await getFileStatus();
        setGitFileStatus(fileStatus);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logForDebugging(`Error getting changed files: ${errorMessage}`, {
          level: 'error',
        });
        setError(t('Failed to get changed files'));
      } finally {
        setLoading(false);
      }
    };

    void loadChangedFiles();
  }, []);

  const handleStash = async () => {
    setStashing(true);
    try {
      logForDebugging('Stashing changes before teleport...');
      const success = await stashToCleanState('Teleport auto-stash');

      if (success) {
        logForDebugging('Successfully stashed changes');
        onStashAndContinue();
      } else {
        setError(t('Failed to stash changes'));
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logForDebugging(`Error stashing changes: ${errorMessage}`, {
        level: 'error',
      });
      setError(t('Failed to stash changes'));
    } finally {
      setStashing(false);
    }
  };

  const handleSelectChange = (value: string) => {
    if (value === 'stash') {
      void handleStash();
    } else {
      onCancel();
    }
  };

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Spinner />
          <Text>
            {t(' Checking git status')}
            {figures.ellipsis}
          </Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="error">
          {t('Error: ')}
          {error}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>{t('Press ')}</Text>
          <Text bold>Escape</Text>
          <Text dimColor>{t(' to cancel')}</Text>
        </Box>
      </Box>
    );
  }

  const showFileCount = changedFiles.length > 8;

  return (
    <Dialog title={t('Working Directory Has Changes')} onCancel={onCancel}>
      <Text>{t('Teleport will switch git branches. The following changes were found:')}</Text>

      <Box flexDirection="column" paddingLeft={2}>
        {changedFiles.length > 0 ? (
          showFileCount ? (
            <Text>{t('{{n}} files changed', { n: changedFiles.length })}</Text>
          ) : (
            changedFiles.map((file: string, index: number) => <Text key={index}>{file}</Text>)
          )
        ) : (
          <Text dimColor>{t('No changes detected')}</Text>
        )}
      </Box>

      <Text>{t('Would you like to stash these changes and continue with teleport?')}</Text>

      {stashing ? (
        <Box>
          <Spinner />
          <Text>{t(' Stashing changes...')}</Text>
        </Box>
      ) : (
        <Select
          options={[
            { label: t('Stash changes and continue'), value: 'stash' },
            { label: t('Exit'), value: 'exit' },
          ]}
          onChange={handleSelectChange}
        />
      )}
    </Dialog>
  );
}
