/**
 * W3 task #54 — /cloud-plugins: choose whether cloud sessions use the plugins
 * enabled on this machine.
 *
 * Persistence follows the /tui marker-file pattern: a flag file under the
 * Claude config home so the choice survives restarts without adding a
 * settings core key. The actual cloud plugin-sync enrollment is feature
 * work — the live call path is gated behind the CLOUD_PLUGINS feature flag
 * and currently reports as not compiled in.
 */

import { feature } from 'bun:bundle'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  LocalCommandCall,
  LocalCommandResult,
} from '../../types/command.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { CLOUD_PLUGINS_USAGE, parseCloudPluginsArgs } from './args.js'

export function getCloudPluginsMarkerPath(): string {
  return join(getClaudeConfigHomeDir(), '.cloud-plugins-enabled')
}

export function isCloudPluginsEnabled(): boolean {
  return existsSync(getCloudPluginsMarkerPath())
}

function enable(): LocalCommandResult {
  mkdirSync(getClaudeConfigHomeDir(), { recursive: true })
  writeFileSync(getCloudPluginsMarkerPath(), new Date().toISOString(), 'utf8')
  return {
    type: 'text',
    value: enabledMessage(),
  }
}

function disabledMessage(): string {
  return [
    '## Cloud plugins disabled',
    '',
    'Cloud sessions will use the cloud-side plugin config, not the plugins',
    'enabled on this machine.',
    '',
    `Re-enable: /cloud-plugins on.  Marker: ${getCloudPluginsMarkerPath()}`,
  ].join('\n')
}

function enabledMessage(): string {
  const lines = [
    '## Cloud plugins enabled',
    '',
    'Cloud sessions will use the plugins enabled on this machine (same set',
    'as this session: commands, skills, agents, hooks, MCP servers).',
  ]
  if (feature('CLOUD_PLUGINS')) {
    lines.push(
      '',
      'Cloud plugin sync is compiled in; enrollment happens on the next',
      'cloud session start.',
    )
  } else {
    lines.push(
      '',
      'Note: the cloud plugin-sync transport is feature-gated',
      '(CLOUD_PLUGINS) and not compiled into this build — your choice is',
      'stored locally and will apply when the sync ships.',
    )
  }
  lines.push(
    '',
    `Disable: /cloud-plugins off.  Marker: ${getCloudPluginsMarkerPath()}`,
  )
  return lines.join('\n')
}

function disable(): LocalCommandResult {
  const path = getCloudPluginsMarkerPath()
  if (existsSync(path)) unlinkSync(path)
  return { type: 'text', value: disabledMessage() }
}

function status(): LocalCommandResult {
  return {
    type: 'text',
    value: [
      '## Cloud plugins',
      '',
      `  Choice:    ${isCloudPluginsEnabled() ? 'enabled' : 'disabled'} — cloud sessions ${
        isCloudPluginsEnabled() ? 'use' : 'do not use'
      } the plugins enabled on this machine`,
      `  Marker:    ${getCloudPluginsMarkerPath()}`,
      `  Transport: ${feature('CLOUD_PLUGINS') ? 'compiled in' : 'feature-gated (not in this build)'}`,
    ].join('\n'),
  }
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parseCloudPluginsArgs(rawArgs)
  switch (args.action) {
    case 'toggle':
      return isCloudPluginsEnabled() ? disable() : enable()
    case 'on':
      return enable()
    case 'off':
      return disable()
    case 'status':
      return status()
    case 'help':
      return { type: 'text', value: CLOUD_PLUGINS_USAGE }
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', CLOUD_PLUGINS_USAGE].join('\n'),
      }
  }
}
