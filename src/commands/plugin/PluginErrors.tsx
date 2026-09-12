import { t } from '../../i18n/index.js';
import { getPluginErrorMessage, type PluginError } from '../../types/plugin.js';

export function formatErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'path-not-found':
      return t('{{component}} path not found: {{path}}', { component: error.component, path: error.path });
    case 'git-auth-failed':
      return t('Git {{authType}} authentication failed for {{url}}', {
        authType: error.authType.toUpperCase(),
        url: error.gitUrl,
      });
    case 'git-timeout':
      return t('Git {{operation}} timed out for {{url}}', {
        operation: error.operation,
        url: error.gitUrl,
      });
    case 'network-error':
      return error.details
        ? t('Network error accessing {{url}}: {{details}}', { url: error.url, details: error.details })
        : t('Network error accessing {{url}}', { url: error.url });
    case 'manifest-parse-error':
      return t('Failed to parse manifest at {{path}}: {{error}}', {
        path: error.manifestPath,
        error: error.parseError,
      });
    case 'manifest-validation-error':
      return t('Invalid manifest at {{path}}: {{error}}', {
        path: error.manifestPath,
        error: error.validationErrors.join(', '),
      });
    case 'plugin-not-found':
      return t('Plugin "{{plugin}}" not found in marketplace "{{marketplace}}"', {
        plugin: error.pluginId,
        marketplace: error.marketplace,
      });
    case 'marketplace-not-found':
      return t('Marketplace "{{name}}" not found', { name: error.marketplace });
    case 'marketplace-load-failed':
      return t('Failed to load marketplace "{{name}}": {{reason}}', {
        name: error.marketplace,
        reason: error.reason,
      });
    case 'mcp-config-invalid':
      return t('Invalid MCP server config for "{{name}}": {{error}}', {
        name: error.serverName,
        error: error.validationError,
      });
    case 'mcp-server-suppressed-duplicate': {
      const dup = error.duplicateOf.startsWith('plugin:')
        ? t('server provided by plugin "{{name}}"', { name: error.duplicateOf.split(':')[1] ?? '?' })
        : t('already-configured "{{name}}"', { name: error.duplicateOf });
      return t('MCP server "{{name}}" skipped — same command/URL as {{dup}}', {
        name: error.serverName,
        dup,
      });
    }
    case 'hook-load-failed':
      return t('Failed to load hooks from {{path}}: {{reason}}', {
        path: error.hookPath,
        reason: error.reason,
      });
    case 'component-load-failed':
      return t('Failed to load {{component}} from {{path}}: {{reason}}', {
        component: error.component,
        path: error.path,
        reason: error.reason,
      });
    case 'mcpb-download-failed':
      return t('Failed to download MCPB from {{url}}: {{reason}}', {
        url: error.url,
        reason: error.reason,
      });
    case 'mcpb-extract-failed':
      return t('Failed to extract MCPB {{path}}: {{reason}}', {
        path: error.mcpbPath,
        reason: error.reason,
      });
    case 'mcpb-invalid-manifest':
      return t('MCPB manifest invalid at {{path}}: {{error}}', {
        path: error.mcpbPath,
        error: error.validationError,
      });
    case 'marketplace-blocked-by-policy':
      return error.blockedByBlocklist
        ? t('Marketplace "{{name}}" is blocked by enterprise policy', { name: error.marketplace })
        : t('Marketplace "{{name}}" is not in the allowed marketplace list', { name: error.marketplace });
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled'
        ? t('Dependency "{{name}}" is disabled', { name: error.dependency })
        : t('Dependency "{{name}}" is not installed', { name: error.dependency });
    case 'lsp-config-invalid':
      return t('Invalid LSP server config for "{{name}}": {{error}}', {
        name: error.serverName,
        error: error.validationError,
      });
    case 'lsp-server-start-failed':
      return t('LSP server "{{name}}" failed to start: {{reason}}', {
        name: error.serverName,
        reason: error.reason,
      });
    case 'lsp-server-crashed':
      return error.signal
        ? t('LSP server "{{name}}" crashed with signal {{signal}}', {
            name: error.serverName,
            signal: error.signal,
          })
        : t('LSP server "{{name}}" crashed with exit code {{code}}', {
            name: error.serverName,
            code: error.exitCode ?? 'unknown',
          });
    case 'lsp-request-timeout':
      return t('LSP server "{{name}}" timed out on {{method}} after {{timeout}}ms', {
        name: error.serverName,
        method: error.method,
        timeout: error.timeoutMs,
      });
    case 'lsp-request-failed':
      return t('LSP server "{{name}}" {{method}} failed: {{error}}', {
        name: error.serverName,
        method: error.method,
        error: error.error,
      });
    case 'plugin-cache-miss':
      return t('Plugin "{{plugin}}" not cached at {{path}}', {
        plugin: error.plugin,
        path: error.installPath,
      });
    case 'generic-error':
      return error.error;
  }
  const _exhaustive: never = error;
  return getPluginErrorMessage(_exhaustive);
}

export function getErrorGuidance(error: PluginError): string | null {
  switch (error.type) {
    case 'path-not-found':
      return t('Check that the path in your manifest or marketplace config is correct');
    case 'git-auth-failed':
      return error.authType === 'ssh'
        ? t('Configure SSH keys or use HTTPS URL instead')
        : t('Configure credentials or use SSH URL instead');
    case 'git-timeout':
    case 'network-error':
      return t('Check your internet connection and try again');
    case 'manifest-parse-error':
      return t('Check manifest file syntax in the plugin directory');
    case 'manifest-validation-error':
      return t('Check manifest file follows the required schema');
    case 'plugin-not-found':
      return t('Plugin may not exist in marketplace "{{name}}"', { name: error.marketplace });
    case 'marketplace-not-found':
      return error.availableMarketplaces.length > 0
        ? t('Available marketplaces: {{list}}', { list: error.availableMarketplaces.join(', ') })
        : t('Add the marketplace first using /plugin marketplace add');
    case 'mcp-config-invalid':
      return t('Check MCP server configuration in .mcp.json or manifest');
    case 'mcp-server-suppressed-duplicate': {
      // duplicateOf is "plugin:name:srv" when another plugin won dedup —
      // users can't remove plugin-provided servers from their MCP config,
      // so point them at the winning plugin instead.
      if (error.duplicateOf.startsWith('plugin:')) {
        const winningPlugin = error.duplicateOf.split(':')[1] ?? 'the other plugin';
        return t('Disable plugin "{{name}}" if you want this plugin\'s version instead', {
          name: winningPlugin,
        });
      }
      return t('Remove "{{name}}" from your MCP config if you want the plugin\'s version instead', {
        name: error.duplicateOf,
      });
    }
    case 'hook-load-failed':
      return t('Check hooks.json file syntax and structure');
    case 'component-load-failed':
      return t('Check {{component}} directory structure and file permissions', {
        component: error.component,
      });
    case 'mcpb-download-failed':
      return t('Check your internet connection and URL accessibility');
    case 'mcpb-extract-failed':
      return t('Verify the MCPB file is valid and not corrupted');
    case 'mcpb-invalid-manifest':
      return t('Contact the plugin author about the invalid manifest');
    case 'marketplace-blocked-by-policy':
      if (error.blockedByBlocklist) {
        return t('This marketplace source is explicitly blocked by your administrator');
      }
      return error.allowedSources.length > 0
        ? t('Allowed sources: {{list}}', { list: error.allowedSources.join(', ') })
        : t('Contact your administrator to configure allowed marketplace sources');
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled'
        ? t('Enable "{{name}}" or uninstall "{{plugin}}"', {
            name: error.dependency,
            plugin: error.plugin,
          })
        : t('Install "{{name}}" or uninstall "{{plugin}}"', {
            name: error.dependency,
            plugin: error.plugin,
          });
    case 'lsp-config-invalid':
      return t('Check LSP server configuration in the plugin manifest');
    case 'lsp-server-start-failed':
    case 'lsp-server-crashed':
    case 'lsp-request-timeout':
    case 'lsp-request-failed':
      return t('Check LSP server logs with --debug for details');
    case 'plugin-cache-miss':
      return t('Run /plugins to refresh the plugin cache');
    case 'marketplace-load-failed':
    case 'generic-error':
      return null;
  }
  const _exhaustive: never = error;
  return null;
}
