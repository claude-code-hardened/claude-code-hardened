import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { t } from '../i18n/index.js';
import { Box, Text, Dialog } from '@anthropic/ink';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { getPlansDirectory } from '../utils/plans.js';
import { setCwd } from '../utils/Shell.js';
import { cleanupWorktree, getCurrentWorktreeSession, keepWorktree, killTmuxSession } from '../utils/worktree.js';
import { Select } from './CustomSelect/select.js';
import { Spinner } from './Spinner.js';

// Inline require breaks the cycle this file would otherwise close:
// sessionStorage → commands → exit → ExitFlow → here. All call sites
// are inside callbacks, so the lazy require never sees an undefined import.
function recordWorktreeExit(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  (require('../utils/sessionStorage.js') as typeof import('../utils/sessionStorage.js')).saveWorktreeState(null);
  /* eslint-enable @typescript-eslint/no-require-imports */
}

type Props = {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  onCancel?: () => void;
};

export function WorktreeExitDialog({ onDone, onCancel }: Props): React.ReactNode {
  const [status, setStatus] = useState<'loading' | 'asking' | 'keeping' | 'removing' | 'done'>('loading');
  const [changes, setChanges] = useState<string[]>([]);
  const [commitCount, setCommitCount] = useState<number>(0);
  const [resultMessage, setResultMessage] = useState<string | undefined>();
  const worktreeSession = getCurrentWorktreeSession();

  useEffect(() => {
    async function loadChanges() {
      let changeLines: string[] = [];
      const gitStatus = await execFileNoThrow('git', ['status', '--porcelain']);
      if (gitStatus.stdout) {
        changeLines = gitStatus.stdout.split('\n').filter(_ => _.trim() !== '');
        setChanges(changeLines);
      }

      // Check for commits to eject
      if (worktreeSession) {
        // Get commits in worktree that are not in original branch
        const { stdout: commitsStr } = await execFileNoThrow('git', [
          'rev-list',
          '--count',
          `${worktreeSession.originalHeadCommit}..HEAD`,
        ]);
        const count = parseInt(commitsStr.trim(), 10) || 0;
        setCommitCount(count);

        // If no changes and no commits, clean up silently
        if (changeLines.length === 0 && count === 0) {
          setStatus('removing');
          void cleanupWorktree()
            .then(() => {
              process.chdir(worktreeSession.originalCwd);
              setCwd(worktreeSession.originalCwd);
              recordWorktreeExit();
              getPlansDirectory.cache.clear?.();
              setResultMessage(t('Worktree removed (no changes)'));
            })
            .catch(error => {
              logForDebugging(`Failed to clean up worktree: ${error}`, {
                level: 'error',
              });
              setResultMessage(t('Worktree cleanup failed, exiting anyway'));
            })
            .then(() => {
              setStatus('done');
            });
          return;
        } else {
          setStatus('asking');
        }
      }
    }
    void loadChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeSession]);

  useEffect(() => {
    if (status === 'done') {
      onDone(resultMessage);
    }
  }, [status, onDone, resultMessage]);

  if (!worktreeSession) {
    onDone(t('No active worktree session found'), { display: 'system' });
    return null;
  }

  if (status === 'loading' || status === 'done') {
    return null;
  }

  async function handleSelect(value: string) {
    if (!worktreeSession) return;

    const hasTmux = Boolean(worktreeSession.tmuxSessionName);

    if (value === 'keep' || value === 'keep-with-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length,
      });
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      if (hasTmux) {
        setResultMessage(
          t(
            'Worktree kept. Your work is saved at {{path}} on branch {{branch}}. Reattach to tmux session with: tmux attach -t {{session}}',
            {
              path: worktreeSession.worktreePath,
              branch: worktreeSession.worktreeBranch,
              session: worktreeSession.tmuxSessionName,
            },
          ),
        );
      } else {
        setResultMessage(
          t('Worktree kept. Your work is saved at {{path}} on branch {{branch}}', {
            path: worktreeSession.worktreePath,
            branch: worktreeSession.worktreeBranch,
          }),
        );
      }
      setStatus('done');
    } else if (value === 'keep-kill-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length,
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      setResultMessage(
        t('Worktree kept at {{path}} on branch {{branch}}. Tmux session terminated.', {
          path: worktreeSession.worktreePath,
          branch: worktreeSession.worktreeBranch,
        }),
      );
      setStatus('done');
    } else if (value === 'remove' || value === 'remove-with-tmux') {
      setStatus('removing');
      logEvent('tengu_worktree_removed', {
        commits: commitCount,
        changed_files: changes.length,
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      try {
        await cleanupWorktree();
        process.chdir(worktreeSession.originalCwd);
        setCwd(worktreeSession.originalCwd);
        recordWorktreeExit();
        getPlansDirectory.cache.clear?.();
      } catch (error) {
        logForDebugging(`Failed to clean up worktree: ${error}`, {
          level: 'error',
        });
        setResultMessage(t('Worktree cleanup failed, exiting anyway'));
        setStatus('done');
        return;
      }
      const tmuxNote = hasTmux ? t(' Tmux session terminated.') : '';
      if (commitCount > 0 && changes.length > 0) {
        setResultMessage(
          t('Worktree removed. {{n}} commit{{s}} and uncommitted changes were discarded.{{tmux}}', {
            n: commitCount,
            s: commitCount === 1 ? '' : 's',
            tmux: tmuxNote,
          }),
        );
      } else if (commitCount > 0) {
        setResultMessage(
          t('Worktree removed. {{n}} commit{{s}} on {{branch}} {{verb}} discarded.{{tmux}}', {
            n: commitCount,
            s: commitCount === 1 ? '' : 's',
            branch: worktreeSession.worktreeBranch,
            verb: commitCount === 1 ? 'was' : 'were',
            tmux: tmuxNote,
          }),
        );
      } else if (changes.length > 0) {
        setResultMessage(t('Worktree removed. Uncommitted changes were discarded.{{tmux}}', { tmux: tmuxNote }));
      } else {
        setResultMessage(t('Worktree removed.{{tmux}}', { tmux: tmuxNote }));
      }
      setStatus('done');
    }
  }

  if (status === 'keeping') {
    return (
      <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>{t('Keeping worktree…')}</Text>
      </Box>
    );
  }

  if (status === 'removing') {
    return (
      <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>{t('Removing worktree…')}</Text>
      </Box>
    );
  }

  const branchName = worktreeSession.worktreeBranch;
  const hasUncommitted = changes.length > 0;
  const hasCommits = commitCount > 0;

  let subtitle = '';
  if (hasUncommitted && hasCommits) {
    subtitle = t(
      'You have {{files}} uncommitted file{{fs}} and {{commits}} commit{{cs}} on {{branch}}. All will be lost if you remove.',
      {
        files: changes.length,
        fs: changes.length === 1 ? '' : 's',
        commits: commitCount,
        cs: commitCount === 1 ? '' : 's',
        branch: branchName,
      },
    );
  } else if (hasUncommitted) {
    subtitle = t('You have {{n}} uncommitted file{{s}}. These will be lost if you remove the worktree.', {
      n: changes.length,
      s: changes.length === 1 ? '' : 's',
    });
  } else if (hasCommits) {
    subtitle = t('You have {{n}} commit{{s}} on {{branch}}. The branch will be deleted if you remove the worktree.', {
      n: commitCount,
      s: commitCount === 1 ? '' : 's',
      branch: branchName,
    });
  } else {
    subtitle = t('You are working in a worktree. Keep it to continue working there, or remove it to clean up.');
  }

  function handleCancel() {
    if (onCancel) {
      // Abort exit and return to the session
      onCancel();
      return;
    }
    // Fallback: treat Escape as "keep" if no onCancel provided
    void handleSelect('keep');
  }

  const removeDescription =
    hasUncommitted || hasCommits ? t('All changes and commits will be lost.') : t('Clean up the worktree directory.');

  const hasTmuxSession = Boolean(worktreeSession.tmuxSessionName);

  const options = hasTmuxSession
    ? [
        {
          label: t('Keep worktree and tmux session'),
          value: 'keep-with-tmux',
          description: t('Stays at {{path}}. Reattach with: tmux attach -t {{session}}', {
            path: worktreeSession.worktreePath,
            session: worktreeSession.tmuxSessionName,
          }),
        },
        {
          label: t('Keep worktree, kill tmux session'),
          value: 'keep-kill-tmux',
          description: t('Keeps worktree at {{path}}, terminates tmux session.', {
            path: worktreeSession.worktreePath,
          }),
        },
        {
          label: t('Remove worktree and tmux session'),
          value: 'remove-with-tmux',
          description: removeDescription,
        },
      ]
    : [
        {
          label: t('Keep worktree'),
          value: 'keep',
          description: t('Stays at {{path}}', { path: worktreeSession.worktreePath }),
        },
        {
          label: t('Remove worktree'),
          value: 'remove',
          description: removeDescription,
        },
      ];

  const defaultValue = hasTmuxSession ? 'keep-with-tmux' : 'keep';

  return (
    <Dialog title={t('Exiting worktree session')} subtitle={subtitle} onCancel={handleCancel}>
      <Select defaultFocusValue={defaultValue} options={options} onChange={handleSelect} />
    </Dialog>
  );
}
