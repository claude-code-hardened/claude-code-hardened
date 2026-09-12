import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { SandboxManager, shouldAllowManagedSandboxDomainsOnly } from '../../utils/sandbox/sandbox-adapter.js';
import { t } from '../../i18n/index.js';

export function SandboxConfigTab(): React.ReactNode {
  const isEnabled = SandboxManager.isSandboxingEnabled();

  // Show warnings (e.g., seccomp not available on Linux)
  const depCheck = SandboxManager.checkDependencies();
  const warningsNote =
    depCheck.warnings.length > 0 ? (
      <Box marginTop={1} flexDirection="column">
        {depCheck.warnings.map((w, i) => (
          <Text key={i} dimColor>
            {w}
          </Text>
        ))}
      </Box>
    ) : null;

  if (!isEnabled) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="subtle">{t('Sandbox is not enabled')}</Text>
        {warningsNote}
      </Box>
    );
  }

  const fsReadConfig = SandboxManager.getFsReadConfig();
  const fsWriteConfig = SandboxManager.getFsWriteConfig();
  const networkConfig = SandboxManager.getNetworkRestrictionConfig();
  const allowUnixSockets = SandboxManager.getAllowUnixSockets();
  const excludedCommands = SandboxManager.getExcludedCommands();
  const globPatternWarnings = SandboxManager.getLinuxGlobPatternWarnings();

  return (
    <Box flexDirection="column" paddingY={1}>
      {/* Excluded Commands */}
      <Box flexDirection="column">
        <Text bold color="permission">
          {t('Excluded Commands:')}
        </Text>
        <Text dimColor>{excludedCommands.length > 0 ? excludedCommands.join(', ') : t('None')}</Text>
      </Box>

      {/* Filesystem Read Restrictions */}
      {fsReadConfig.denyOnly.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="permission">
            {t('Filesystem Read Restrictions:')}
          </Text>
          <Text dimColor>{t('Denied: {{v}}', { v: fsReadConfig.denyOnly.join(', ') })}</Text>
          {fsReadConfig.allowWithinDeny && fsReadConfig.allowWithinDeny.length > 0 && (
            <Text dimColor>{t('Allowed within denied: {{v}}', { v: fsReadConfig.allowWithinDeny.join(', ') })}</Text>
          )}
        </Box>
      )}

      {/* Filesystem Write Restrictions */}
      {fsWriteConfig.allowOnly.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="permission">
            {t('Filesystem Write Restrictions:')}
          </Text>
          <Text dimColor>{t('Allowed: {{v}}', { v: fsWriteConfig.allowOnly.join(', ') })}</Text>
          {fsWriteConfig.denyWithinAllow.length > 0 && (
            <Text dimColor>{t('Denied within allowed: {{v}}', { v: fsWriteConfig.denyWithinAllow.join(', ') })}</Text>
          )}
        </Box>
      )}

      {/* Network Restrictions */}
      {((networkConfig.allowedHosts && networkConfig.allowedHosts.length > 0) ||
        (networkConfig.deniedHosts && networkConfig.deniedHosts.length > 0)) && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="permission">
            {t('Network Restrictions{{m}}:', { m: shouldAllowManagedSandboxDomainsOnly() ? t(' (Managed)') : '' })}
          </Text>
          {networkConfig.allowedHosts && networkConfig.allowedHosts.length > 0 && (
            <Text dimColor>{t('Allowed: {{v}}', { v: networkConfig.allowedHosts.join(', ') })}</Text>
          )}
          {networkConfig.deniedHosts && networkConfig.deniedHosts.length > 0 && (
            <Text dimColor>{t('Denied: {{v}}', { v: networkConfig.deniedHosts.join(', ') })}</Text>
          )}
        </Box>
      )}

      {/* Unix Sockets */}
      {allowUnixSockets && allowUnixSockets.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="permission">
            {t('Allowed Unix Sockets:')}
          </Text>
          <Text dimColor>{allowUnixSockets.join(', ')}</Text>
        </Box>
      )}

      {/* Linux Glob Pattern Warning */}
      {globPatternWarnings.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="warning">
            {t('⚠ Warning: Glob patterns not fully supported on Linux')}
          </Text>
          <Text dimColor>
            {t('The following patterns will be ignored: {{v}}', { v: globPatternWarnings.slice(0, 3).join(', ') })}
            {globPatternWarnings.length > 3 && t(' ({{n}} more)', { n: globPatternWarnings.length - 3 })}
          </Text>
        </Box>
      )}

      {warningsNote}
    </Box>
  );
}
