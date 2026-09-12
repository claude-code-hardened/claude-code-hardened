import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { getPlatform } from '../../utils/platform.js';
import type { SandboxDependencyCheck } from '../../utils/sandbox/sandbox-adapter.js';
import { t } from '../../i18n/index.js';

type Props = {
  depCheck: SandboxDependencyCheck;
};

export function SandboxDependenciesTab({ depCheck }: Props): React.ReactNode {
  const platform = getPlatform();
  const isMac = platform === 'macos';

  // ripgrep is required on all platforms (used to scan for dangerous dirs).
  // On macOS, seatbelt is built into the OS — ripgrep is the only runtime dep.
  // On Linux/WSL, bwrap + socat are required, seccomp is optional.
  //
  // #31804: previously this tab unconditionally rendered Linux deps (bwrap,
  // socat, seccomp). When ripgrep was missing on macOS, users saw confusing
  // Linux install instructions and no mention of the actual problem.
  const rgMissing = depCheck.errors.some(e => e.includes('ripgrep'));
  const bwrapMissing = depCheck.errors.some(e => e.includes('bwrap'));
  const socatMissing = depCheck.errors.some(e => e.includes('socat'));
  const seccompMissing = depCheck.warnings.length > 0;

  // Any errors we don't have a dedicated row for — render verbatim so they
  // aren't silently swallowed (e.g. "Unsupported platform" or future deps).
  const otherErrors = depCheck.errors.filter(
    e => !e.includes('ripgrep') && !e.includes('bwrap') && !e.includes('socat'),
  );

  const rgInstallHint = isMac ? 'brew install ripgrep' : 'apt install ripgrep';

  return (
    <Box flexDirection="column" paddingY={1} gap={1}>
      {isMac && (
        <Box flexDirection="column">
          <Text>
            {t('seatbelt: ')}
            <Text color="success">{t('built-in (macOS)')}</Text>
          </Text>
        </Box>
      )}

      <Box flexDirection="column">
        <Text>
          {t('ripgrep (rg): ')}
          {rgMissing ? <Text color="error">{t('not found')}</Text> : <Text color="success">{t('found')}</Text>}
        </Text>
        {rgMissing && (
          <Text dimColor>
            {'  '}· {rgInstallHint}
          </Text>
        )}
      </Box>

      {!isMac && (
        <>
          <Box flexDirection="column">
            <Text>
              {t('bubblewrap (bwrap): ')}
              {bwrapMissing ? (
                <Text color="error">{t('not installed')}</Text>
              ) : (
                <Text color="success">{t('installed')}</Text>
              )}
            </Text>
            {bwrapMissing && <Text dimColor>{'  '}· apt install bubblewrap</Text>}
          </Box>

          <Box flexDirection="column">
            <Text>
              {t('socat: ')}
              {socatMissing ? (
                <Text color="error">{t('not installed')}</Text>
              ) : (
                <Text color="success">{t('installed')}</Text>
              )}
            </Text>
            {socatMissing && <Text dimColor>{'  '}· apt install socat</Text>}
          </Box>

          <Box flexDirection="column">
            <Text>
              {t('seccomp filter: ')}
              {seccompMissing ? (
                <Text color="warning">{t('not installed')}</Text>
              ) : (
                <Text color="success">{t('installed')}</Text>
              )}
              {seccompMissing && <Text dimColor>{t(' (required to block unix domain sockets)')}</Text>}
            </Text>
            {seccompMissing && (
              <Box flexDirection="column">
                <Text dimColor>{'  '}· npm install -g @anthropic-ai/sandbox-runtime</Text>
                <Text dimColor>{'  '}· or copy vendor/seccomp/* from sandbox-runtime and set</Text>
                <Text dimColor>{'    '}sandbox.seccomp.bpfPath and applyPath in settings.json</Text>
              </Box>
            )}
          </Box>
        </>
      )}

      {otherErrors.map(err => (
        <Text key={err} color="error">
          {err}
        </Text>
      ))}
    </Box>
  );
}
