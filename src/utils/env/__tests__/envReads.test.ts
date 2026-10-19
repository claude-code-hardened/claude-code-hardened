import { afterEach, describe, expect, test } from 'bun:test'
import {
  isAgentViewRelaunch,
  isArtifactAutoOpen,
  isEvalConfined,
  isSpawnedByServer,
  shouldPropagateNestedMemory,
  getStageFileRoot,
} from '../envReads.js'
import { AUTO_MODE_ENV_VAR, isAutoModeEnabled } from '../autoModeEnv.js'
import {
  isHookForwardingDisabled,
  isHookForwardingEnabled,
  isPluginForwardingDisabled,
  isPluginForwardingEnabled,
} from '../forwardingGates.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('envReads (scattered env face)', () => {
  test('scattered gates default off', () => {
    delete process.env.CLAUDE_CODE_SPAWNED_BY_SERVER
    delete process.env.CLAUDE_STAGE_FILE_ROOT
    delete process.env.CLAUDE_CODE_EVAL_CONFINED
    delete process.env.CLAUDE_CODE_AGENT_VIEW_RELAUNCH
    delete process.env.CLAUDE_CODE_ARTIFACT_AUTO_OPEN
    delete process.env.CLAUDE_CODE_COORDINATOR_PROPAGATE_NESTED_MEMORY

    expect(isSpawnedByServer()).toBe(false)
    expect(getStageFileRoot()).toBeUndefined()
    expect(isEvalConfined()).toBe(false)
    expect(isAgentViewRelaunch()).toBe(false)
    expect(isArtifactAutoOpen()).toBe(false)
    expect(shouldPropagateNestedMemory()).toBe(false)
  })

  test('truthy values flip the scattered gates', () => {
    process.env.CLAUDE_CODE_SPAWNED_BY_SERVER = '1'
    process.env.CLAUDE_CODE_EVAL_CONFINED = 'true'
    process.env.CLAUDE_CODE_AGENT_VIEW_RELAUNCH = 'yes'
    process.env.CLAUDE_CODE_ARTIFACT_AUTO_OPEN = 'on'
    process.env.CLAUDE_CODE_COORDINATOR_PROPAGATE_NESTED_MEMORY = '1'

    expect(isSpawnedByServer()).toBe(true)
    expect(isEvalConfined()).toBe(true)
    expect(isAgentViewRelaunch()).toBe(true)
    expect(isArtifactAutoOpen()).toBe(true)
    expect(shouldPropagateNestedMemory()).toBe(true)
  })

  test('stage file root uses the official CLAUDE_STAGE_FILE_ROOT name', () => {
    delete process.env.CLAUDE_STAGE_FILE_ROOT
    expect(getStageFileRoot()).toBeUndefined()
    process.env.CLAUDE_STAGE_FILE_ROOT = '/tmp/stage'
    expect(getStageFileRoot()).toBe('/tmp/stage')
  })

  test('explicit falsy values do not count as set', () => {
    process.env.CLAUDE_CODE_EVAL_CONFINED = '0'
    expect(isEvalConfined()).toBe(false)
    process.env.CLAUDE_CODE_SPAWNED_BY_SERVER = 'off'
    expect(isSpawnedByServer()).toBe(false)
  })
})

describe('autoModeEnv (CLAUDE_CODE_ENABLE_AUTO_MODE gate)', () => {
  test('auto mode defaults off', () => {
    delete process.env[AUTO_MODE_ENV_VAR]
    expect(isAutoModeEnabled()).toBe(false)
  })

  test('auto mode turns on only with an explicit truthy value', () => {
    process.env[AUTO_MODE_ENV_VAR] = '1'
    expect(isAutoModeEnabled()).toBe(true)
    process.env[AUTO_MODE_ENV_VAR] = '0'
    expect(isAutoModeEnabled()).toBe(false)
  })
})

describe('forwardingGates', () => {
  test('forwarding stays enabled when the kill switches are unset', () => {
    delete process.env.CLAUDE_CODE_DISABLE_HOOK_FORWARDING
    delete process.env.CLAUDE_CODE_DISABLE_PLUGIN_FORWARDING
    expect(isHookForwardingDisabled()).toBe(false)
    expect(isHookForwardingEnabled()).toBe(true)
    expect(isPluginForwardingDisabled()).toBe(false)
    expect(isPluginForwardingEnabled()).toBe(true)
  })

  test('kill switches disable forwarding', () => {
    process.env.CLAUDE_CODE_DISABLE_HOOK_FORWARDING = '1'
    process.env.CLAUDE_CODE_DISABLE_PLUGIN_FORWARDING = 'true'
    expect(isHookForwardingDisabled()).toBe(true)
    expect(isHookForwardingEnabled()).toBe(false)
    expect(isPluginForwardingDisabled()).toBe(true)
    expect(isPluginForwardingEnabled()).toBe(false)
  })
})
